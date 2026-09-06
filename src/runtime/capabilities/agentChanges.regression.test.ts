import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { createAgentHooksCapability } from './agentHooks'
import { createAgentChangesStore } from './agentChanges'
import { filesFromTool } from './agentChangeEdits'
import { filterAgentChanges, summarizeAgentChanges } from '../../shared/agentChanges'
import type { AgentId } from '../../shared/agents'

// Deliberately provider-shaped fixtures, not generated from our normalizer.
const adapters = [
  { id: 'claude-code', tool: 'Edit', wrap: (input: unknown, output: unknown, session: string, call: string) => ({ hook_event_name: 'PostToolUse', session_id: session, tool_use_id: call, tool_name: 'Edit', tool_input: input, tool_response: output }) },
  { id: 'codex', tool: 'apply_patch', wrap: (input: unknown, output: unknown, session: string, call: string) => ({ hook_event_name: 'PostToolUse', session_id: session, tool_use_id: call, tool_name: 'apply_patch', tool_input: input, tool_response: output }) },
  { id: 'cursor', tool: 'edit', wrap: (input: unknown, output: unknown, session: string, call: string) => ({ hook_event_name: 'postToolUse', conversation_id: session, tool_use_id: call, tool_name: 'edit', tool_input: input, tool_output: output }) },
  { id: 'grok', tool: 'replace_file_content', wrap: (input: unknown, output: unknown, session: string, call: string) => ({ hookEventName: 'post_tool_use', sessionId: session, toolUseId: call, toolName: 'replace_file_content', toolInput: input, toolResponse: output }) },
  { id: 'kiro', tool: 'fs_write', wrap: (input: unknown, output: unknown, session: string, call: string) => ({ hook_event_name: 'PostToolUse', session_id: session, tool_use_id: call, tool_name: 'fs_write', tool_input: input, tool_response: output }) },
  { id: 'opencode', tool: 'edit', wrap: (input: unknown, output: unknown, session: string, call: string) => ({ type: 'message.part.updated', sessionID: session, part: { type: 'tool', tool: 'edit', callID: call, state: { status: 'completed', input, metadata: output } } }) },
] as const
let directory: string
let hooks: ReturnType<typeof createAgentHooksCapability>
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'cate-capture-regression-'))
  hooks = createAgentHooksCapability({ hooksDir: path.join(directory, 'hooks'), changesDir: path.join(directory, 'history') })
  hooks.registerChangeSource('one', { cwd: '/repo', panelId: 'panel-one', kind: 'terminal' })
  hooks.registerChangeSource('two', { cwd: '/repo', panelId: 'panel-two', kind: 'terminal' })
})
afterEach(async () => { hooks.dispose(); await rm(directory, { recursive: true, force: true }) })
async function post(agentId: AgentId, payload: unknown, terminalId = 'one') {
  const endpoint = await hooks.endpoint()
  const response = await fetch(endpoint.url + '/hook', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.tokenFor(terminalId)}` }, body: JSON.stringify({ agentId, terminalId, payload }) })
  expect(response.status).toBe(204)
}

describe.each(adapters)('$id capture contract', (adapter) => {
  it('tracks successive turn boundaries without merging reused tool-call IDs', async () => {
    const lifecycle = (start: boolean) => adapter.id === 'opencode'
      ? { type: 'session.status', sessionID: 'session', status: { type: start ? 'busy' : 'idle' } }
      : adapter.id === 'grok'
        ? { hookEventName: start ? 'user_prompt_submit' : 'stop', sessionId: 'session' }
        : adapter.id === 'cursor'
          ? { hook_event_name: start ? 'beforeSubmitPrompt' : 'stop', conversation_id: 'session' }
          : { hook_event_name: start ? 'UserPromptSubmit' : 'Stop', session_id: 'session' }
    for (const text of ['first', 'second']) {
      await post(adapter.id, lifecycle(true))
      if (adapter.id === 'opencode') await post(adapter.id, lifecycle(true))
      await post(adapter.id, adapter.wrap({ file_path: 'same.ts', old_string: 'old', new_string: text }, {}, 'session', 'same-call-id'))
      await post(adapter.id, lifecycle(false))
    }
    const records = await hooks.listChanges('/repo')
    expect(records).toHaveLength(2)
    expect(new Set(records.map((record) => record.turnId)).size).toBe(2)
    expect(records.every((record) => !record.turnId.startsWith('unscoped:'))).toBe(true)
  })

  it('keeps successful edits isolated by session/panel/turn, deduplicates retries, and persists only change data', async () => {
    const input = { file_path: 'shared.ts', old_string: 'before', new_string: 'after' }
    const first = { ...adapter.wrap(input, { privateMetadata: 'DO_NOT_PERSIST' }, 'session-one', 'call'), turn_id: 'turn-one', prompt: 'DO_NOT_PERSIST' }
    await Promise.all([post(adapter.id, first), post(adapter.id, { ...adapter.wrap({ ...input, new_string: 'other-agent' }, {}, 'session-two', 'call'), turn_id: 'turn-one' }, 'two')])
    await post(adapter.id, first)
    await post(adapter.id, { ...adapter.wrap({ ...input, new_string: 'next-turn' }, {}, 'session-one', 'call'), turn_id: 'turn-two' })
    const records = await hooks.listChanges('/repo')
    expect(records).toHaveLength(3)
    const own = filterAgentChanges(records, { agentId: adapter.id, panelId: 'panel-one', turnId: 'turn-one' })
    expect(own).toHaveLength(1)
    expect(own[0]).toMatchObject({ sessionId: 'session-one', files: [{ path: 'shared.ts', coverage: 'fragment', additions: 1, deletions: 1 }] })
    expect(own[0].files[0].hunks.flatMap((h) => h.lines.map((l) => l.text))).toEqual(['before', 'after'])
    expect(filterAgentChanges(records, { panelId: 'panel-two' })).toHaveLength(1)
    expect(await createAgentChangesStore(path.join(directory, 'history')).list('/repo')).toEqual(records)
    expect(await hooks.listChanges('/other-repo')).toEqual([])
    for (const file of await readdir(path.join(directory, 'history'))) expect(await readFile(path.join(directory, 'history', file), 'utf8')).not.toContain('DO_NOT_PERSIST')
  })

  it('rejects unsuccessful, out-of-workspace and sessionless changes', async () => {
    const input = { file_path: 'a.ts', old_string: 'a', new_string: 'b' }
    for (const output of [{ is_error: true }, { success: false }, { status: 'failed' }, { status: 'declined' }]) await post(adapter.id, adapter.wrap(input, output, 'session', JSON.stringify(output)))
    await post(adapter.id, adapter.wrap({ ...input, file_path: '../outside.ts' }, {}, 'session', 'outside'))
    await post(adapter.id, adapter.wrap(input, {}, '', 'sessionless'))
    expect(await hooks.listChanges('/repo')).toEqual([])
  })

  it('captures structured before/after patches and marks missing before-images as unavailable', async () => {
    await post(adapter.id, adapter.wrap({ file_path: 'unknown.ts', content: 'new contents' }, {}, 'session', 'write'))
    await post(adapter.id, adapter.wrap({}, { content: [{ type: 'diff', path: 'exact.ts', oldText: 'old\nunchanged\n', newText: 'new\nunchanged\n' }] }, 'session', 'exact'))
    const files = (await hooks.listChanges('/repo')).flatMap((r) => r.files)
    expect(files[0]).toMatchObject({ path: 'unknown.ts', coverage: 'unavailable', hunks: [], additions: 0, deletions: 0 })
    expect(files[1]).toMatchObject({ path: 'exact.ts', coverage: 'patch', additions: 1, deletions: 1 })
    expect(files[1].hunks.flatMap((h) => h.lines).filter((l) => l.kind === 'context').map((l) => l.text)).toContain('unchanged')
  })

  if (adapter.id !== 'opencode') it.skipIf(process.platform === 'win32')('runs the materialized stdin bridge through HTTP to durable capture', async () => {
    const env = await hooks.envForPty('one', { PATH: process.env.PATH ?? '' })
    if (adapter.id === 'grok') env.GROK_HOOK_EVENT = 'post_tool_use'
    const endpoint = await hooks.endpoint()
    await new Promise<void>((resolve, reject) => {
      const child = execFile(path.join(endpoint.dir, `cate-hook-bridge-${adapter.id}`), [], { env, timeout: 10000 }, (error) => error ? reject(error) : resolve())
      child.stdin!.end(JSON.stringify(adapter.wrap({ file_path: 'bridge.ts', old_string: 'a', new_string: 'b' }, {}, 'bridge-session', 'bridge-call')))
    })
    expect(summarizeAgentChanges(await hooks.listChanges('/repo'))).toMatchObject([{ path: 'bridge.ts', additions: 1, deletions: 1 }])
  })
})

describe.each(['claude', 'codex', 'cursor', 'grok', 'kiro', 'opencode'])('%s canonical T3 changes', (provider) => {
  it('captures only completed edits and keeps concurrent conversations isolated', async () => {
    const store = createAgentChangesStore(path.join(directory, 't3'))
    store.registerSource('harness', { cwd: '/repo', kind: 't3' })
    const event = (threadId: string, status: string) => ({ provider, type: 'item.completed', threadId, turnId: 'turn', itemId: 'same-item-id', payload: { status, data: { toolName: 'Edit', input: { file_path: `${threadId}.ts`, old_string: 'old', new_string: 'new' } } } })
    await store.ingestT3('harness', event('failed', 'failed'))
    await store.ingestT3('harness', { ...event('running', 'completed'), type: 'item.started' })
    await Promise.all([store.ingestT3('harness', event('one', 'completed')), store.ingestT3('harness', event('two', 'completed')), store.bind('/repo', 'one', 'panel-one')])
    await store.ingestT3('harness', event('one', 'completed'))
    expect(await store.list('/repo')).toHaveLength(2)
    expect(filterAgentChanges(await store.list('/repo'), { panelId: 'panel-one' })).toMatchObject([{ sourceId: 'one', files: [{ path: 'one.ts', additions: 1, deletions: 1 }] }])
    expect(await store.summary('harness', 'two', 'turn')).toMatchObject([{ path: 'two.ts' }])
  })
})

it('preserves provider-specific multiline, multi-edit, create, delete and Codex patch shapes', () => {
  expect(filesFromTool('/repo', 'MultiEdit', { file_path: 'a.ts', edits: [{ old_string: 'a\nb', new_string: 'c' }, { old_string: 'd', new_string: 'e\nf' }] })[0]).toMatchObject({ additions: 3, deletions: 3, coverage: 'fragment' })
  expect(filesFromTool('/repo', 'Write', { file_path: 'new.ts', content: 'a\nb\n' }, { type: 'create' })[0]).toMatchObject({ additions: 2, deletions: 0, coverage: 'patch' })
  expect(filesFromTool('/repo', 'fileChange', { changes: [{ path: 'deleted.ts', diff: '@@ -1,2 +0,0 @@\n-a\n-b\n' }] })[0]).toMatchObject({ additions: 0, deletions: 2, coverage: 'patch' })
  expect(filesFromTool('/repo', 'apply_patch', '*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** Add File: b.ts\n+created\n*** End Patch')[1]).toMatchObject({ path: 'b.ts', additions: 1, coverage: 'fragment' })
})

it('executes the generated OpenCode plugin and retains child-session linkage', async () => {
  await hooks.prepareWorkspace(directory, { opencode: 'on' })
  const env = await hooks.envForPty('one', { PATH: process.env.PATH ?? '' })
  const plugin = await readFile(path.join(directory, '.opencode/plugin/cate-hook.js'), 'utf8')
  const script = `
    const { CateHookBridge } = await import(${JSON.stringify('data:text/javascript;base64,' + Buffer.from(plugin).toString('base64'))});
    const bridge = await CateHookBridge();
    await bridge.event({ event: { type: 'session.created', properties: { info: { id: 'child', parentID: 'parent' } } } });
    await bridge.event({ event: { type: 'message.part.updated', properties: { part: { sessionID: 'child', type: 'tool', tool: 'edit', callID: 'edit', state: { status: 'completed', input: { filePath: 'plugin.ts', oldString: 'old', newString: 'new' } } } } } });
  `
  await new Promise<void>((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', script], { env, timeout: 10000 }, (error) => error ? reject(error) : resolve()))
  expect(filterAgentChanges(await hooks.listChanges('/repo'), { sessionId: 'parent' })).toMatchObject([{ agentId: 'opencode', sessionId: 'child', parentSessionId: 'parent', files: [{ path: 'plugin.ts', additions: 1, deletions: 1 }] }])
})
