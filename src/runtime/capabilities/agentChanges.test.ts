import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, mkdir, symlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createAgentChangesStore } from './agentChanges'
import { filesFromPatch, filesFromTool } from './agentChangeEdits'
import { filterAgentChanges, summarizeAgentChanges } from '../../shared/agentChanges'
import { normalizeAgentHookPayload } from '../../shared/agentHooks'
import type { AgentId } from '../../shared/agents'
import { createAgentHooksCapability } from './agentHooks'

const patch = (file: string, before = 'old', after = 'new') => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${before}\n+${after}\n`
let directory: string
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'cate-changes-test-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe('reported agent changes', () => {
  it('joins canonical and symlinked checkout paths into one history', async () => {
    const cwd = path.join(directory, 'repo')
    const alias = path.join(directory, 'alias')
    await mkdir(cwd)
    await symlink(cwd, alias, 'dir')
    const store = createAgentChangesStore(path.join(directory, 'history'))
    store.registerSource('harness', { cwd, kind: 't3' })
    await store.ingestT3('harness', { provider: 'codex', type: 'turn.diff.updated', threadId: 'chat', turnId: 'turn', payload: { unifiedDiff: patch('a.ts') } })
    await store.bind(alias, 'chat', 'panel')
    expect(filterAgentChanges(await store.list(alias), { panelId: 'panel' })).toHaveLength(1)
  })
  it('ingests real HTTP hook/provider posts with source-bound authorization', async () => {
    const hooks = createAgentHooksCapability({ hooksDir: directory, changesDir: path.join(directory, 'history') })
    hooks.registerChangeSource('pty', { cwd: '/repo', panelId: 'terminal-panel', kind: 'terminal' })
    hooks.registerChangeSource('t3', { cwd: '/repo', kind: 't3' })
    const endpoint = await hooks.endpoint()
    const post = (route: string, source: string, payload: unknown, tokenSource = source) => fetch(endpoint.url + route, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.tokenFor(tokenSource)}` },
      body: JSON.stringify({ terminalId: source, agentId: 'claude-code', payload }),
    })
    try {
      expect((await post('/hook', 'pty', { hook_event_name: 'PostToolUse', session_id: 'cli-session', tool_name: 'Edit', tool_input: { file_path: 'cli.ts', old_string: 'a', new_string: 'b' } })).status).toBe(204)
      const event = { type: 'turn.diff.updated', provider: 'codex', threadId: 'chat', turnId: 'turn', payload: { unifiedDiff: patch('chat.ts') } }
      expect((await post('/t3-changes', 't3', event, 'pty')).status).toBe(401)
      expect((await post('/t3-changes', 't3', event)).status).toBe(200)
      expect((await hooks.listChanges('/repo')).flatMap((r) => r.files.map((f) => f.path)).sort()).toEqual(['chat.ts', 'cli.ts'])
    } finally { hooks.dispose() }
  })
  it('parses multi-file patches, deletes, quoted paths and rejects traversal', () => {
    const files = filesFromPatch('/repo', patch('a.ts') + patch('b.ts') + patch('../secret'))
    expect(files.map((file) => file.path)).toEqual(['a.ts', 'b.ts'])
    expect(files[0]).toMatchObject({ additions: 1, deletions: 1, coverage: 'patch' })
    expect(filesFromPatch('/repo', patch('a.ts').replace('+++ b/a.ts', '+++ /dev/null'))[0].path).toBe('a.ts')
    expect(filesFromPatch('/repo', 'diff --git "a/a b.ts" "b/a b.ts"\n--- "a/a b.ts"\n+++ "b/a b.ts"\n@@ -1 +1 @@\n-a\n+b\n')[0].path).toBe('a b.ts')
  })

  it('does not invent before images for Write, or absolute line numbers for Edit', () => {
    expect(filesFromTool('/repo', 'Write', { file_path: '/repo/a.ts', content: 'hello' })[0]).toMatchObject({ coverage: 'unavailable', hunks: [] })
    expect(filesFromTool('/repo', 'Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' })[0]).toMatchObject({ coverage: 'fragment', additions: 1, deletions: 1 })
    expect(filesFromTool('/repo', 'Read', { file_path: 'a.ts' })).toEqual([])
    expect(filesFromTool('/repo', 'Edit', { file_path: '/another/a.ts', old_string: 'a', new_string: 'b' })).toEqual([])
  })

  it('preserves successful ACP and Claude structured patches without reading the checkout', () => {
    const files = filesFromTool('/repo', 'edit', {}, { content: [{ type: 'diff', path: 'a.ts', oldText: 'a\nsame\n', newText: 'b\nsame\n' }] })
    expect(files[0]).toMatchObject({ coverage: 'patch', additions: 1, deletions: 1 })
    expect(filesFromTool('/repo', 'Edit', { file_path: 'b.ts' }, { structuredPatch: [{ oldStart: 20, oldLines: 1, newStart: 20, newLines: 1, lines: ['-a', '+b'] }] })[0].hunks[0].oldStart).toBe(20)
  })

  it.each<AgentId>(['claude-code', 'codex', 'cursor', 'grok', 'kiro', 'opencode'])('records successful %s hooks using session ownership and panel association', async (agentId) => {
    const store = createAgentChangesStore(directory)
    store.registerSource('pty', { cwd: '/repo', panelId: 'panel', kind: 'terminal' })
    const input = { file_path: 'a.ts', old_string: 'before', new_string: 'after' }
    const raw = agentId === 'opencode'
      ? { type: 'message.part.updated', sessionID: 'session', part: { type: 'tool', tool: 'edit', callID: 'edit', state: { status: 'completed', input } } }
      : agentId === 'grok'
        ? { hookEventName: 'post_tool_use', sessionId: 'session', toolName: 'replace_file_content', toolInput: input, toolUseId: 'edit' }
        : { hook_event_name: agentId === 'cursor' ? 'postToolUse' : 'PostToolUse', session_id: 'session', tool_name: 'Edit', tool_input: input, tool_use_id: 'edit' }
    await store.ingestHook('pty', agentId, raw, normalizeAgentHookPayload(agentId, 'pty', raw))
    await store.ingestHook('pty', agentId, raw, normalizeAgentHookPayload(agentId, 'pty', raw))
    const records = await store.list('/repo')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ agentId, sessionId: 'session', panelId: 'panel', files: [{ path: 'a.ts' }] })
  })

  it('keeps concurrent chats separate, replaces cumulative snapshots, and survives restart', async () => {
    const store = createAgentChangesStore(directory)
    store.registerSource('harness', { cwd: '/repo', kind: 't3' })
    const event = (threadId: string, diff: string, createdAt = '2026-09-06T00:00:00Z') => ({ provider: 'codex', type: 'turn.diff.updated', threadId, turnId: 'turn', createdAt, payload: { unifiedDiff: diff } })
    await Promise.all([
      store.ingestT3('harness', event('chat-a', patch('a.ts'))),
      store.ingestT3('harness', event('chat-b', patch('b.ts'))),
      store.bind('/repo', 'chat-a', 'panel-a'),
    ])
    await store.ingestT3('harness', event('chat-a', patch('a.ts', 'old', 'newer'), '2026-09-06T00:00:01Z'))
    await store.ingestT3('harness', event('chat-a', patch('stale.ts')))
    const records = await createAgentChangesStore(directory).list('/repo')
    expect(records).toHaveLength(2)
    expect(summarizeAgentChanges(filterAgentChanges(records, { panelId: 'panel-a' })).map((file) => file.path)).toEqual(['a.ts'])
    expect((await store.summary('harness', 'chat-b', 'turn')).map((file) => file.path)).toEqual(['b.ts'])
    expect(await store.list('/another')).toEqual([])
    await store.ingestT3('harness', event('chat-a', '', '2026-09-06T00:00:02Z'))
    expect(await store.summary('harness', 'chat-a', 'turn')).toEqual([])
  })

  it('excludes failed tools and keeps subagent identity linked to the parent chat', async () => {
    const store = createAgentChangesStore(directory)
    store.registerSource('harness', { cwd: '/repo', kind: 't3' })
    const event = { provider: 'claude', type: 'item.completed', threadId: 'chat', turnId: 'turn', itemId: 'edit', payload: {
      status: 'failed', agentId: 'child', data: { toolName: 'Edit', input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' } },
    } }
    await store.ingestT3('harness', event)
    expect(await store.list('/repo')).toEqual([])
    await store.ingestT3('harness', { ...event, payload: { ...event.payload, status: 'completed' } })
    expect(filterAgentChanges(await store.list('/repo'), { sessionId: 'chat' })[0]).toMatchObject({ sessionId: 'chat:child', parentSessionId: 'chat', sourceId: 'chat' })
  })
})
