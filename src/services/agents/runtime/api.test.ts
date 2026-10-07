import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isRpcError } from '@kernel/rpc/contract'
import type { ApiHandlerContext } from '@kernel/api/contract'
import type { PanelRecord } from '@workspace/document/contract'
import type { AgentRunner, PanelAgentState } from '../contract'
import { createAgentApiHandlers } from './api'
import { agentsCapabilityImpl } from './capability'
import { createAgentsRuntime, type AgentsRuntime } from './agentsRuntime'
import type { AgentRunnerImpl } from './registry'
import type { AgentStarter } from './start'

function fakeRunner(kind: AgentRunner) {
  const states = new Map<string, PanelAgentState>()
  const listeners = new Set<(panelId: string) => void>()
  const runner: AgentRunnerImpl = {
    kind,
    state: (panelId) => states.get(panelId) ?? null,
    panelIds: () => states.keys(),
    send: vi.fn(async () => ({ ok: true as const })),
    interrupt: vi.fn(async () => ({ ok: true as const })),
    conversation: vi.fn(async (panelId: string) => {
      const session = states.get(panelId)?.session
      return session ? { session, messages: [{ role: 'user' as const, text: 'hello' }] } : null
    }),
    onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const set = (panelId: string, state: Partial<PanelAgentState>) => {
    states.set(panelId, {
      panelId, runner: kind, agentId: 'codex', agentName: 'Codex', status: 'waitingForInput',
      present: true, canReceivePrompt: true, session: null, ...state,
    })
    for (const listener of listeners) listener(panelId)
  }
  return { runner, set }
}

const ctx = (overrides: Partial<ApiHandlerContext['caller']> = {}, signal = new AbortController().signal): ApiHandlerContext => ({
  caller: { kind: 'cli', id: 'caller', panelId: 'supervisor', ...overrides },
  method: 'cate.agent.x',
  signal,
  sticky: { get: () => undefined, set: () => {}, clear: () => {} },
  defaultTarget: () => undefined,
  invoke: async () => undefined,
})

const panels: PanelRecord[] = [
  { id: 'term', type: 'terminal', title: 'Backend', fields: {} },
  { id: 'chat', type: 'chat', title: 'Frontend', fields: {} },
]

let dir: string
let agents: AgentsRuntime
let terminal: ReturnType<typeof fakeRunner>
let t3: ReturnType<typeof fakeRunner>
let handlers: ReturnType<typeof createAgentApiHandlers>
let starter: AgentStarter

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cate-agents-api-'))
  agents = createAgentsRuntime({
    root: '/repo',
    agentsDir: dir,
    trust: { isTrusted: () => true, requireTrusted: () => {} },
    settings: { agentHookInjection: () => ({}), panelRelationsEnabled: () => true },
    relationRole: () => undefined,
    document: {
      panel: (id) => panels.find((panel) => panel.id === id),
      panels: () => panels,
      relations: () => [],
      worktreePath: () => undefined,
      relationContextMode: () => 'once',
      setRelationContextMode: () => {},
      setTitleFromAgent: () => {},
      onChange: () => () => {},
    },
    resolveCheckout: async (cwd) => cwd ?? '/repo',
    snapshot: async () => ({ nameByPid: new Map(), childrenByPid: new Map() }),
  })
  terminal = fakeRunner('terminal')
  t3 = fakeRunner('t3')
  agents.registry.register(terminal.runner)
  agents.registry.register(t3.runner)
  starter = {
    start: vi.fn(async () => ({ panelId: 'new', runner: 'terminal' as const, agentId: 'codex' as const })),
    types: vi.fn(async () => []),
  }
  handlers = createAgentApiHandlers(agents, starter)
})

afterEach(() => {
  agents.dispose()
  rmSync(dir, { recursive: true, force: true })
})

async function rpcError(promise: unknown): Promise<string> {
  try { await promise } catch (error) {
    expect(isRpcError(error)).toBe(true)
    return (error as Error).message
  }
  throw new Error('expected an error')
}

describe('cate.agent.*', () => {
  it('lists live agents of both runners, never an idle terminal', async () => {
    terminal.set('term', { status: 'running', canReceivePrompt: false })
    t3.set('chat', { status: 'notRunning', agentId: null, agentName: 'T3 Code' })
    terminal.set('idle-shell', { status: 'notRunning', present: true })
    expect(await handlers.list({}, ctx())).toEqual([
      { panelId: 'term', runner: 'terminal', title: 'Backend', agentId: 'codex', agentName: 'Codex', state: 'running', canReceivePrompt: false },
      { panelId: 'chat', runner: 't3', title: 'Frontend', agentId: null, agentName: 'T3 Code', state: 'notRunning', canReceivePrompt: true },
    ])
  })

  it('reads a conversation through the panel\'s runner', async () => {
    terminal.set('term', { session: { agentId: 'codex', runner: 'terminal', sessionId: 's', cwd: '/repo' } })
    await expect(handlers.read({ panelId: 'term' }, ctx())).resolves.toMatchObject({
      panelId: 'term', session: { sessionId: 's' }, messages: [{ role: 'user', text: 'hello' }],
    })
    t3.set('chat', {})
    await expect(rpcError(handlers.read({ panelId: 'chat' }, ctx()))).resolves.toBe('no-agent-session')
    await expect(rpcError(handlers.read({ panelId: 'none' }, ctx()))).resolves.toBe('agent-panel-not-found')
  })

  it('sends through the runner and turns a refusal into an error', async () => {
    terminal.set('term', {})
    await expect(handlers.send({ targetPanelId: 'term', prompt: 'go' }, ctx())).resolves.toEqual({ ok: true })
    expect(terminal.runner.send).toHaveBeenCalledWith('term', 'go')
    vi.mocked(terminal.runner.send).mockResolvedValueOnce({ ok: false, error: 'agent-busy' })
    await expect(rpcError(handlers.send({ targetPanelId: 'term', prompt: 'go' }, ctx()))).resolves.toBe('agent-busy')
  })

  it('waits until every named agent can take a prompt', async () => {
    terminal.set('term', { status: 'running', canReceivePrompt: false })
    const waiting = handlers.wait({ panelIds: ['term'], timeoutSeconds: 5 }, ctx())
    terminal.set('term', { status: 'waitingForInput', canReceivePrompt: true })
    await expect(waiting).resolves.toMatchObject({ timedOut: false, agents: [{ panelId: 'term', state: 'waitingForInput' }] })
    await expect(rpcError(handlers.wait({ panelIds: ['gone'], timeoutSeconds: 5 }, ctx()))).resolves.toBe('agent-panel-not-found')
  })

  it('times out with the current states', async () => {
    vi.useFakeTimers()
    try {
      terminal.set('term', { status: 'running', canReceivePrompt: false })
      const waiting = handlers.wait({ panelIds: ['term'], timeoutSeconds: 5 }, ctx())
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(waiting).resolves.toMatchObject({ timedOut: true, agents: [{ state: 'running' }] })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('cate.agent.start', () => {
  it('starts for the calling panel, on the canvas it names', async () => {
    await handlers.start({ prompt: 'Fix it', runner: 'terminal', canvasPanelId: 'canvas', position: { x: 10, y: 20 } }, ctx())
    expect(starter.start).toHaveBeenCalledWith('supervisor', { prompt: 'Fix it', runner: 'terminal', placement: { near: 'canvas', position: { x: 10, y: 20 } } })
  })

  it('leaves the place to the starter without a canvas, and starts for a client without a panel', async () => {
    await handlers.start({ prompt: 'Fix it', runner: 't3', model: 'gpt' }, ctx({ kind: 'client', panelId: undefined }))
    expect(starter.start).toHaveBeenCalledWith(undefined, { prompt: 'Fix it', runner: 't3', model: 'gpt' })
  })
})

describe('agents capability', () => {
  it('streams every agent panel\'s state as a snapshot, then changes', () => {
    terminal.set('term', {})
    const events: unknown[] = []
    const impl = agentsCapabilityImpl(agents)
    const stop = impl.panels(undefined as never, { emit: (event: unknown) => events.push(event) } as never, {} as never)
    t3.set('chat', { status: 'running' })
    expect(events).toEqual([
      { kind: 'snapshot', rev: 0, snapshot: { term: expect.objectContaining({ panelId: 'term' }) } },
      { kind: 'change', rev: 1, change: { chat: expect.objectContaining({ status: 'running' }) } },
    ])
    ;(stop as () => void)()
  })

  it('reports running agents as busy and forwards notifications', () => {
    terminal.set('term', { status: 'running' })
    t3.set('chat', {})
    expect(agentsCapabilityImpl(agents).busy(undefined as never, {} as never)).toEqual({ panelIds: ['term'] })
    const seen: unknown[] = []
    const impl = agentsCapabilityImpl(agents)
    impl.notifications(undefined as never, { emit: (event: unknown) => seen.push(event) } as never, {} as never)
    agents.notifications.publish({ kind: 'agent.needsInput', panelId: 'term', title: 't', body: 'b' })
    expect(seen).toEqual([{ kind: 'agent.needsInput', panelId: 'term', title: 't', body: 'b' }])
  })
})
