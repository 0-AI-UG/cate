import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import os from 'node:os'
import path from 'node:path'
import { createAgentChangesStore } from './agentChanges'
import { filesFromPatch, filesFromTool } from './agentChangeEdits'
import { normalizeAgentHookPayload } from '../../shared/agentHooks'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

let directory: string
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'cate-review-changes-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

const event = (threadId: string) => ({ provider: 'claude', type: 'item.completed', threadId, turnId: 'turn', itemId: 'edit', payload: {
  status: 'completed', data: { toolName: 'Edit', input: { file_path: `${threadId}.ts`, old_string: 'a', new_string: 'b' } },
} })

it('preserves concurrent writes and bindings from independent store instances', async () => {
  const stores = Array.from({ length: 8 }, () => createAgentChangesStore(directory))
  stores.forEach((store) => store.registerSource('source', { cwd: '/repo', kind: 't3' }))
  await Promise.all(stores.map(async (store, index) => {
    await store.ingestT3('source', event(`chat-${index}`))
    await store.bind('/repo', `chat-${index}`, `panel-${index}`)
  }))
  const records = await createAgentChangesStore(directory).list('/repo')
  expect(records).toHaveLength(8)
  expect(records.every((record) => record.panelIds?.[0] === record.sourceId.replace('chat', 'panel'))).toBe(true)
})

it('preserves concurrently published records across independent Node processes', async () => {
  const bundled = await build({ entryPoints: ['src/runtime/capabilities/agentChanges.ts'], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false })
  const children = Array.from({ length: 4 }, (_, index) => {
    const script = bundled.outputFiles[0].text + `
      const store = module.exports.createAgentChangesStore(${JSON.stringify(directory)});
      store.registerSource('source', {cwd:'/repo', kind:'t3'});
      process.stdin.once('data', async () => {
        try {
          await store.ingestT3('source', ${JSON.stringify(event(`process-${index}`))});
          await store.bind('/repo', 'process-${index}', 'panel-${index}');
          process.exit(0);
        } catch(error) { console.error(error); process.exit(1); }
      });
      process.stdout.write('ready');
    `
    const child = spawn(process.execPath, ['-e', script], { stdio: 'pipe' })
    const ready = new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject) })
    const done = new Promise<void>((resolve, reject) => {
      let stderr = ''
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr || `Exit ${code}`)))
      child.once('error', reject)
    })
    return { child, ready, done }
  })
  try {
    await Promise.all(children.map((child) => child.ready))
    children.forEach(({ child }) => child.stdin.end('go'))
    await Promise.all(children.map((child) => child.done))
    const records = await createAgentChangesStore(directory).list('/repo')
    expect(records).toHaveLength(4)
    expect(records.every((record) => record.panelIds?.length === 1)).toBe(true)
  } finally { children.forEach(({ child }) => child.kill()) }
})

it('returns only a revision for unchanged history and observes other writers', async () => {
  const reader = createAgentChangesStore(directory)
  const writer = createAgentChangesStore(directory)
  writer.registerSource('source', { cwd: '/repo', kind: 't3' })
  const empty = await reader.readChanges('/repo')
  expect(empty.records).toEqual([])
  expect(await reader.readChanges('/repo', empty.revision)).toEqual({ revision: empty.revision })
  await writer.ingestT3('source', event('new-chat'))
  const changed = await reader.readChanges('/repo', empty.revision)
  expect(changed.revision).not.toBe(empty.revision)
  expect(changed.records).toHaveLength(1)
  expect(await reader.readChanges('/repo', changed.revision)).toEqual({ revision: changed.revision })
})

it('reads legacy history without rewriting it and refuses to write past corrupt history', async () => {
  const store = createAgentChangesStore(directory)
  store.registerSource('source', { cwd: '/repo', kind: 't3' })
  await store.ingestT3('source', event('old-chat'))
  const records = await store.list('/repo')
  const legacyFile = path.join(directory, createHash('sha256').update(records[0].cwd).digest('hex') + '.json')
  const content = JSON.stringify({ version: 1, records, bindings: { 'old-chat': ['old-panel'] } })
  await writeFile(legacyFile, content)
  await store.ingestT3('source', event('new-chat'))
  expect(await readFile(legacyFile, 'utf8')).toBe(content)
  expect(await store.list('/repo')).toHaveLength(2)
  expect((await store.list('/repo')).find((record) => record.sourceId === 'old-chat')?.panelIds).toEqual(['old-panel'])
  await writeFile(legacyFile, '{broken')
  await expect(store.ingestT3('source', event('blocked'))).rejects.toThrow()
  expect(await readFile(legacyFile, 'utf8')).toBe('{broken')
})

it('compacts only older immutable snapshots and deduplicates operation retries', async () => {
  const stores = [createAgentChangesStore(directory), createAgentChangesStore(directory)]
  stores.forEach((store) => store.registerSource('source', { cwd: '/repo', kind: 't3' }))
  const snapshot = (createdAt: string, name: string) => ({ provider: 'codex', type: 'turn.diff.updated', threadId: 'snapshot-chat', turnId: 'turn', createdAt,
    payload: { unifiedDiff: `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-a\n+b\n` } })
  await Promise.all([
    stores[0].ingestT3('source', snapshot('2026-01-01T00:00:02Z', 'new.ts')),
    stores[1].ingestT3('source', snapshot('2026-01-01T00:00:01Z', 'old.ts')),
    ...stores.map((store) => store.ingestT3('source', event('operation'))),
  ])
  await Promise.all(stores.map((store) => store.list('/repo')))
  const records = await createAgentChangesStore(directory).list('/repo')
  expect(records).toHaveLength(2)
  expect(records.find((record) => record.mode === 'snapshot')?.files[0].path).toBe('new.ts')
  await stores[0].ingestT3('source', snapshot('2026-01-01T00:00:02Z', 'same-timestamp-later.ts'))
  expect((await stores[1].list('/repo')).find((record) => record.mode === 'snapshot')?.files[0].path).toBe('same-timestamp-later.ts')
  const folder = (await readdir(directory)).find((name) => name.endsWith('.d'))!
  expect((await readdir(path.join(directory, folder))).filter((name) => name.endsWith('.json'))).toHaveLength(2)
})

it('retries a read when another reader compacts its listed snapshot before it opens the file', async () => {
  const writer = createAgentChangesStore(directory)
  const reader = createAgentChangesStore(directory)
  const compactor = createAgentChangesStore(directory)
  writer.registerSource('source', { cwd: '/repo', kind: 't3' })
  const snapshot = (createdAt: string, name: string) => ({ provider: 'codex', type: 'turn.diff.updated', threadId: 'chat', turnId: 'turn', createdAt,
    payload: { unifiedDiff: `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-a\n+b\n` } })
  await writer.ingestT3('source', snapshot('2026-01-01T00:00:01Z', 'old.ts'))
  const folder = path.join(directory, (await readdir(directory)).find((name) => name.endsWith('.d'))!)
  const oldFile = path.join(folder, (await readdir(folder))[0])
  const originalRead = fs.readFile.bind(fs)
  const spy = vi.mocked(readFile).mockImplementationOnce(async (file) => {
    expect(file).toBe(oldFile)
    await writer.ingestT3('source', snapshot('2026-01-01T00:00:02Z', 'new.ts'))
    await compactor.list('/repo')
    // The real read now fails with ENOENT: compaction removed the file after
    // the first reader enumerated it, without adding the new name to its list.
    return originalRead(file, 'utf8')
  })
  try {
    expect((await reader.list('/repo')).map((record) => record.files[0].path)).toEqual(['new.ts'])
    expect(spy).toHaveBeenCalled()
  } finally { spy.mockRestore() }
})

it('resolves reported relative paths from the agent cwd within the source workspace', async () => {
  const cwd = path.join(directory, 'repo')
  const agentCwd = path.join(cwd, 'packages', 'app')
  await mkdir(agentCwd, { recursive: true })
  const store = createAgentChangesStore(path.join(directory, 'history'))
  store.registerSource('pty', { cwd, kind: 'terminal' })
  const payload = { hook_event_name: 'PostToolUse', session_id: 'session', tool_use_id: 'edit', cwd: agentCwd,
    tool_name: 'Edit', tool_input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' } }
  await store.ingestHook('pty', 'claude-code', payload, normalizeAgentHookPayload('claude-code', 'pty', payload))
  expect((await store.list(cwd))[0].files[0].path).toBe('packages/app/src/a.ts')
  const outside = { ...payload, tool_use_id: 'outside', cwd: directory }
  await store.ingestHook('pty', 'claude-code', outside, normalizeAgentHookPayload('claude-code', 'pty', outside))
  expect(await store.list(cwd)).toHaveLength(1)
})

it('decodes Git octal UTF-8 filenames', () => {
  const patch = 'diff --git "a/\\303\\251.ts" "b/\\303\\251.ts"\n--- "a/\\303\\251.ts"\n+++ "b/\\303\\251.ts"\n@@ -1 +1 @@\n-a\n+b\n'
  expect(filesFromPatch('/repo', patch)).toMatchObject([{ path: 'é.ts', additions: 1, deletions: 1 }])
})

it('captures apply_patch rename destinations and original paths', () => {
  const patch = '*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n@@\n-a\n+b\n*** End Patch'
  expect(filesFromTool('/repo', 'apply_patch', patch)).toMatchObject([{ path: 'new.ts', oldPath: 'old.ts', additions: 1, deletions: 1 }])
  expect(filesFromTool('/repo', 'apply_patch', patch.replace('new.ts', '../outside.ts'))).toEqual([])
})
