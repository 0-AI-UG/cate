import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { panelDefinition } from '@panels/definitions'
import type { T3ShellEvent, T3Thread } from '@services/t3/contract'
import type { PanelRecord, PanelRelation } from '@workspace/document/contract'
import { createAgentsCore, type AgentsCore } from '../../core'
import type {AgentsDocument } from '../../promptContext'
import type { RelationContextMode } from '@workspace/relations/contract'
import { createAgentChangesStore } from '../../changes/store'
import { createT3Runner, type RunnerT3Service, type T3PanelBindings, type T3Runner } from './t3Runner'
import type { NotificationEvent } from '@workspace/notifications/contract'


const CHECKOUT = '/repo'

function fakeDocument(panels: PanelRecord[], relations: PanelRelation[]) {
  const modes = new Map<string, RelationContextMode>()
  const titles: Array<{ panelId: string; title: string }> = []
  const document: AgentsDocument = {
    panel: (id) => panels.find((panel) => panel.id === id),
    panels: () => panels,
    relations: () => relations,
    worktreePath: () => undefined,
    setRelationContextMode: (id, mode) => {
      modes.set(id, mode)
      const record = panels.find((panel) => panel.id === id)
      if (record) record.fields = { ...record.fields, relationContextMode: mode }
    },
    setTitleFromAgent: (panelId, title) => { titles.push({ panelId, title }) },
    onChange: () => () => {},
  }
  return { document, modes, titles }
}

let shellListener: (event: T3ShellEvent) => void
let sequence = 0
let turns: Array<{ checkout?: string; threadId: string; text: string }>
let startTurn: ReturnType<typeof vi.fn<RunnerT3Service['startTurn']>>
let binding: { checkout: string; threadId?: string } | undefined
let doc: ReturnType<typeof fakeDocument>
let agents: AgentsCore
let runner: T3Runner
let notifications: NotificationEvent[]
let statusListener: (status: { isRepo: boolean; files: { path: string }[] }) => void = () => {}
const dirs: string[] = []

function publish(threads: Record<string, T3Thread>, connected = true): void {
  shellListener({ kind: 'snapshot', snapshot: { instanceId: 'i', checkout: CHECKOUT, connected, sequence: ++sequence, threads } })
}

const idle = (title = 'Chat'): T3Thread => ({ id: 'thread-1', title, latestTurn: { state: 'completed' }, session: { status: 'ready', activeTurnId: null, providerName: 'codex' } })
const running = (): T3Thread => ({ ...idle(), latestTurn: { state: 'running' }, session: { status: 'running', activeTurnId: 't', providerName: 'codex' } })

beforeEach(() => {
  notifications = []
  turns = []
  startTurn = vi.fn<RunnerT3Service['startTurn']>(async (params) => { turns.push(params) })
  binding = { checkout: CHECKOUT, threadId: 'thread-1' }
  const t3: RunnerT3Service = {
    watchThreadShells: (listener) => { shellListener = listener; return () => {} },
    readConversation: async ({ threadId }) => threadId === 'thread-1'
      ? [{ role: 'user', text: 'hello', createdAt: '2026-01-01T00:00:00.000Z' }]
      : null,
    startTurn,
    interruptTurn: async () => {},
  }
  const bindings: T3PanelBindings = {
    binding: (panelId) => (panelId === 'chat' ? binding : undefined),
    panelIds: () => ['chat'],
    onChange: () => () => {},
    sendFresh: vi.fn(async () => true),
  }
  doc = fakeDocument([
    { id: 'chat', type: 'chat', title: 'Chat', fields: {} },
    { id: 'browser', type: 'browser', title: 'Browser', fields: {} },
  ], [{ id: 'r', fromPanelId: 'chat', toPanelId: 'browser', kind: 'use' }])
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cate-t3-runner-'))
  dirs.push(dir)
  agents = createAgentsCore({
    root: CHECKOUT,
    agentsDir: dir,
    trust: { isTrusted: () => true, requireTrusted: () => {} },
    settings: { agentHookInjection: () => ({}), panelRelationsEnabled: () => true },
    relationRole: (type) => panelDefinition(type)?.relation,
    document: doc.document,
    resolveCheckout: async (cwd) => cwd ?? CHECKOUT,
    snapshot: async () => ({ nameByPid: new Map(), childrenByPid: new Map() }),
    notify: (event) => { notifications.push(event) },
    watchStatus: (_cwd, listener) => { statusListener = listener; return () => {} },
  })
  runner = createT3Runner(agents, t3, bindings)
  agents.registry.register(runner)
})

afterEach(() => {
  runner.dispose()
  agents.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('t3 runner', () => {
  it('attributes a thread\'s recorded edits to the panels showing it, and follows the panel\'s session', async () => {
    const store = createAgentChangesStore(path.join(dirs.at(-1)!, 'changes'))
    store.registerSource('harness', { cwd: CHECKOUT, kind: 't3' })
    const diff = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n'
    await store.ingestT3('harness', { provider: 'codex', type: 'turn.diff.updated', threadId: 'thread-1', turnId: 'turn', payload: { unifiedDiff: diff } })
    publish({ 'thread-1': idle() })

    const { records } = await agents.changes(CHECKOUT)
    expect(records).toMatchObject([{ sessionId: 'thread-1', panelIds: ['chat'] }])
    expect(records![0]).not.toHaveProperty('sourceId')

    const seen: unknown[] = []
    const stop = agents.watchChanges('chat', (changes) => seen.push(changes))
    statusListener({ isRepo: true, files: [{ path: 'a.ts' }] })
    await vi.waitFor(() => expect(seen.at(-1)).toEqual({ sessionId: 'thread-1', turns: { turn: [{ path: 'a.ts', kind: 'modified', additions: 1, deletions: 1 }] } }))
    stop()
  })

  it('hosts nothing until the harness reports the panel\'s thread', () => {
    expect(agents.panel('chat')).toBeNull()
    publish({ 'thread-1': idle() })
    expect(agents.panel('chat')).toEqual({
      panelId: 'chat',
      agentId: 'codex',
      agentName: 'Codex',
      label: 'Codex',
      takesOverPanel: false,
      contextPolicy: 'supported',
      status: 'waitingForInput',
      present: true,
      canReceivePrompt: true,
      session: { agentId: 'codex', runner: 't3', sessionId: 'thread-1', cwd: CHECKOUT },
    })
  })

  it('notifies when a running turn ends or blocks on an approval, and follows the thread title', () => {
    publish({ 'thread-1': running() })
    expect(agents.panel('chat')).toMatchObject({ status: 'running', canReceivePrompt: false })
    publish({ 'thread-1': idle('Renamed') })
    expect(notifications).toEqual([{ kind: 'agent.needsInput', panelId: 'chat', title: 'Codex needs input', body: 'Codex is waiting for your response.' }])
    expect(doc.titles).toEqual([{ panelId: 'chat', title: 'Chat' }, { panelId: 'chat', title: 'Renamed' }])
    publish({ 'thread-1': { ...running(), hasPendingApprovals: true } })
    expect(notifications.at(-1)).toMatchObject({ kind: 'agent.needsPermission', body: 'Waiting for your approval.' })
  })

  it('sends a prompt with the relation context to the bound thread', async () => {
    publish({ 'thread-1': idle() })
    await expect(agents.send('chat', 'Do it')).resolves.toEqual({ ok: true })
    expect(turns).toHaveLength(1)
    expect(turns[0].text).toMatch(/^Do it\n\n<cate-connected-panels>/)
    expect(turns[0].text).toContain('outside the Codex sandbox')
    expect(doc.modes.get('chat')).toBe('off')
  })

  it('refuses a busy thread and a disconnected harness', async () => {
    publish({ 'thread-1': running() })
    await expect(agents.send('chat', 'x')).resolves.toEqual({ ok: false, error: 'agent-busy' })
    publish({ 'thread-1': idle() }, false)
    expect(agents.panel('chat')?.label).toBe('Codex (disconnected)')
    await expect(agents.send('chat', 'x')).resolves.toEqual({ ok: false, error: 'agent-not-running' })
    expect(turns).toEqual([])
  })

  it('reports a turn the harness refused as busy', async () => {
    publish({ 'thread-1': idle() })
    startTurn.mockRejectedValueOnce(new Error('agent-busy'))
    await expect(agents.send('chat', 'hi')).resolves.toEqual({ ok: false, error: 'agent-busy' })
    startTurn.mockRejectedValueOnce(new Error('T3 conversation update returned HTTP 500'))
    await expect(agents.send('chat', 'hi')).resolves.toEqual({ ok: false, error: 'agent-panel-unavailable' })
  })

  it('sends a fresh chat\'s first prompt through its page composer', async () => {
    binding = { checkout: CHECKOUT }
    publish({})
    expect(agents.panel('chat')).toMatchObject({ agentName: 'T3 Code', label: 'T3 Code', canReceivePrompt: true, session: null })
    await expect(agents.send('chat', 'hi')).resolves.toEqual({ ok: true })
    expect(turns).toEqual([])
  })

  it('reads the conversation from the thread', async () => {
    publish({ 'thread-1': idle() })
    await expect(runner.conversation('chat')).resolves.toMatchObject({
      session: { runner: 't3', sessionId: 'thread-1' },
      messages: [{ role: 'user', text: 'hello' }],
    })
  })

  it('gives a starting harness the change capture env and accepts its reported edits', async () => {
    const env = await runner.changeCaptureEnv({ id: 'harness-1', checkout: CHECKOUT })
    expect(env.CATE_CHANGES_SOURCE).toBe('harness-1')
    const response = await fetch(`${env.CATE_CHANGES_ENDPOINT}/t3-changes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.CATE_CHANGES_TOKEN}` },
      body: JSON.stringify({ terminalId: 'harness-1', payload: {
        provider: 'codex', type: 'item.completed', threadId: 'thread-1', turnId: 'turn-1', itemId: 'edit',
        payload: { status: 'completed', data: { toolName: 'Edit', input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' } } },
      } }),
    })
    expect(response.status).toBe(200)
    const records = (await agents.hooks.readChanges(CHECKOUT)).records!
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ source: 't3', sourceId: 'thread-1', agentId: 'codex', files: [{ path: 'a.ts' }] })
    runner.releaseChangeCapture('harness-1')
  })
})
