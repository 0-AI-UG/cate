import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import os from 'node:os'
import path from 'node:path'
import { createAgentChangesStore } from './store'
import { filesFromPatch, filesFromTool } from './edits'
import { AGENT_HOOK_SPECS, normalizeAgentHookPayload } from '../../contract'

let directory: string
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'cate-review-changes-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

/** A reported Edit by session `sessionId`, as a terminal's hook posts it. */
const edit = (sessionId: string) => ({ sessionId, turnId: 'turn', name: 'Edit', callId: 'edit', output: null,
  input: { file_path: `${sessionId}.ts`, old_string: 'a', new_string: 'b' } })

it('preserves concurrent writes from independent store instances', async () => {
  const stores = Array.from({ length: 8 }, (_, index) => {
    const store = createAgentChangesStore(directory)
    store.registerTerminal('source', { cwd: '/repo', panelId: `panel-${index}` })
    return store
  })
  await Promise.all(stores.map((store, index) => store.ingestHook('source', 'claude-code', null, edit(`chat-${index}`))))
  const records = await createAgentChangesStore(directory).list('/repo')
  expect(records).toHaveLength(8)
  expect(records.every((record) => record.panelId === record.sessionId.replace('chat', 'panel'))).toBe(true)
})

it('preserves concurrently published records across independent Node processes', async () => {
  const bundled = await build({ entryPoints: ['src/services/agents/runtime/changes/store.ts'], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false })
  // Loaded from a file: inlined into -e, the bundle exceeds Windows' command-line limit.
  const bundleDir = await mkdtemp(path.join(os.tmpdir(), 'cate-agent-changes-bundle-'))
  const bundleFile = path.join(bundleDir, 'agentChanges.cjs')
  await writeFile(bundleFile, bundled.outputFiles[0].text)
  const children = Array.from({ length: 4 }, (_, index) => {
    const script = `
      const store = require(${JSON.stringify(bundleFile)}).createAgentChangesStore(${JSON.stringify(directory)});
      store.registerTerminal('source', {cwd:'/repo', panelId:'panel-${index}'});
      process.stdin.once('data', async () => {
        try {
          await store.ingestHook('source', 'claude-code', null, ${JSON.stringify(edit(`process-${index}`))});
          process.exit(0);
        } catch(error) { console.error(error); process.exit(1); }
      });
      process.stdout.write('ready');
    `
    const child = spawn(process.execPath, ['-e', script], {
      stdio: 'pipe', env: { ...process.env, NODE_PATH: path.resolve('node_modules') },
    })
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
    expect(records.every((record) => record.panelId === record.sessionId.replace('process', 'panel'))).toBe(true)
  } finally {
    children.forEach(({ child }) => child.kill())
    await rm(bundleDir, { recursive: true, force: true })
  }
})

it('returns only a revision for unchanged history and observes other writers', async () => {
  const reader = createAgentChangesStore(directory)
  const writer = createAgentChangesStore(directory)
  writer.registerTerminal('source', { cwd: '/repo' })
  const empty = await reader.readChanges('/repo')
  expect(empty.records).toEqual([])
  expect(await reader.readChanges('/repo', empty.revision)).toEqual({ revision: empty.revision })
  await writer.ingestHook('source', 'claude-code', null, edit('new-chat'))
  const changed = await reader.readChanges('/repo', empty.revision)
  expect(changed.revision).not.toBe(empty.revision)
  expect(changed.records).toHaveLength(1)
  expect(await reader.readChanges('/repo', changed.revision)).toEqual({ revision: changed.revision })
})

it('resolves reported relative paths from the agent cwd within the source workspace', async () => {
  const cwd = path.join(directory, 'repo')
  const agentCwd = path.join(cwd, 'packages', 'app')
  await mkdir(agentCwd, { recursive: true })
  const store = createAgentChangesStore(path.join(directory, 'history'))
  store.registerTerminal('pty', { cwd })
  const payload = { hook_event_name: 'PostToolUse', session_id: 'session', tool_use_id: 'edit', cwd: agentCwd,
    tool_name: 'Edit', tool_input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' } }
  await store.ingestHook('pty', 'claude-code', normalizeAgentHookPayload('claude-code', 'pty', payload), AGENT_HOOK_SPECS['claude-code'].toolCall(payload))
  expect((await store.list(cwd))[0].files[0].path).toBe('packages/app/src/a.ts')
  const outside = { ...payload, tool_use_id: 'outside', cwd: directory }
  await store.ingestHook('pty', 'claude-code', normalizeAgentHookPayload('claude-code', 'pty', outside), AGENT_HOOK_SPECS['claude-code'].toolCall(outside))
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

it('captures the command-wrapped apply_patch input emitted by real Codex CLI 0.153.4', async () => {
  const store = createAgentChangesStore(directory)
  store.registerTerminal('pty', { cwd: '/repo', panelId: 'panel' })
  // Observed through the shipped bridge during agentChanges.claudeCodex.itest.
  // Only session/turn/cwd are anonymized. Codex wraps native patch text in
  // `command`, even though this is an apply_patch call rather than Bash.
  const payload = {
    session_id: 'live-session', turn_id: 'live-turn', transcript_path: null, cwd: '/repo',
    hook_event_name: 'PostToolUse', model: 'gpt-5.4-mini', permission_mode: 'bypassPermissions',
    tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: target.txt\n+after\n*** End Patch\n' },
    tool_response: 'Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nA target.txt\n',
    tool_use_id: 'live-call',
  }
  await store.ingestHook('pty', 'codex', normalizeAgentHookPayload('codex', 'pty', payload), AGENT_HOOK_SPECS['codex'].toolCall(payload))
  expect(await store.list('/repo')).toMatchObject([{ agentId: 'codex', sessionId: 'live-session', turnId: 'live-turn', panelId: 'panel',
    files: [{ path: 'target.txt', additions: 1, deletions: 0, coverage: 'fragment' }] }])
  expect(filesFromTool('/repo', 'Bash', payload.tool_input, payload.tool_response)).toEqual([])
})

it('marks native patch deletion without a before image as unavailable', () => {
  const input = { command: '*** Begin Patch\n*** Delete File: obsolete.txt\n*** End Patch\n' }
  expect(filesFromTool('/repo', 'apply_patch', input)).toMatchObject([{ path: 'obsolete.txt', coverage: 'unavailable', hunks: [], additions: 0, deletions: 0 }])
})

it('does not invent a before image for the real OpenCode whole-file write payload', () => {
  // OpenCode 1.18.29 reported exists:true, but no previous text, after writing
  // target.txt during the live suite. A prior Read is not authorship evidence.
  const input = { filePath: '/repo/target.txt', content: 'after\n' }
  const metadata = { diagnostics: {}, filepath: '/repo/target.txt', exists: true, truncated: false }
  expect(filesFromTool('/repo', 'write', input, metadata)).toMatchObject([
    { path: 'target.txt', coverage: 'unavailable', hunks: [], additions: 0, deletions: 0 },
  ])
})

it.each([
  ['before\n', 'after\n', ['before'], ['after']],
  ['before\n\n', 'after\n\n', ['before', ''], ['after', '']],
  ['\nbefore\n', '\nafter\n', ['', 'before'], ['', 'after']],
  ['before', 'after', ['before'], ['after']],
  ['before\r\n', 'after\r\n', ['before'], ['after']],
  ['\n', '', [''], []],
])('counts actual fragment lines without a phantom newline sentinel (%j -> %j)', (before, after, deleted, added) => {
  const [file] = filesFromTool('/repo', 'edit', { filePath: 'target.txt', oldString: before, newString: after })
  const lines = file.hunks.flatMap((hunk) => hunk.lines)
  expect(lines.filter((line) => line.kind === 'delete').map((line) => line.text)).toEqual(deleted)
  expect(lines.filter((line) => line.kind === 'add').map((line) => line.text)).toEqual(added)
  expect(file).toMatchObject({ additions: added.length, deletions: deleted.length })
})
