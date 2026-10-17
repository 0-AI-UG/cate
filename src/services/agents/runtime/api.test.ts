import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isRpcError } from '@kernel/rpc/contract'
import type { ApiHandlerContext } from '@kernel/api/contract'
import type { PanelRecord } from '@workspace/document/contract'
import type { PanelAgentState } from '../contract'
import { createAgentApiHandlers } from './api'
import { agentsCapabilityImpl } from './capability'
import { createAgentsCore, type AgentsCore, type AgentTerminals } from './core'
import type { AgentStarter } from './start'


function fakeTerminals() {
  const states = new Map<string, PanelAgentState>()
  const listeners = new Set<(panelId: string) => void>()
  const terminals: AgentTerminals = {
    state: (panelId) => states.get(panelId) ?? null,
    panelIds: () => states.keys(),
    send: vi.fn(async () => ({ ok: true as const })),
    interrupt: vi.fn(async () => ({ ok: true as const })),
    conversation: vi.fn(async (panelId: string) => {
      const session = states.get(panelId)?.session
      return session ? { session, messages: [{ role: 'user' as const, text: 'hello' }] } : null
    }),
    conversationStamp: async () => null,
    onStep: () => () => {},
    dispose: () => {},
    onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const set = (panelId: string, state: Partial<PanelAgentState>) => {
    states.set(panelId, {
      panelId, agentId: 'codex', agentName: 'Codex', label: 'Codex', contextPolicy: null, status: 'waitingForInput',
      present: true, canReceivePrompt: true, session: null, ...state,
    })
    for (const listener of listeners) listener(panelId)
  }
  return { terminals, set }
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
  { id: 'term-2', type: 'terminal', title: 'Frontend', fields: {} },
]

let dir: string
let agents: AgentsCore
let terminal: ReturnType<typeof fakeTerminals>
let handlers: ReturnType<typeof createAgentApiHandlers>
let starter: AgentStarter

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cate-agents-api-'))
  terminal = fakeTerminals()
  agents = createAgentsCore({
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
      setRelationContextMode: () => {},
      setTitleFromAgent: () => {},
      onChange: () => () => {},
    },
    resolveCheckout: async (cwd) => cwd ?? '/repo',
    snapshot: async () => ({ nameByPid: new Map(), childrenByPid: new Map() }),
    notify: () => {},
  }, () => terminal.terminals)
  starter = {
    start: vi.fn(async () => ({ panelId: 'new', agentId: 'codex' as const })),
    types: vi.fn(async () => []),
    starting: vi.fn(() => []),
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
  it('lists live agents, never an idle terminal', async () => {
    terminal.set('term', { status: 'running', canReceivePrompt: false })
    terminal.set('idle-shell', { status: 'notRunning', present: true })
    expect(await handlers.list({}, ctx())).toEqual([
      { panelId: 'term', title: 'Backend', agentId: 'codex', agentName: 'Codex', state: 'running', canReceivePrompt: false },
    ])
  })

  it('reads the panel\'s conversation', async () => {
    terminal.set('term', { session: { agentId: 'codex', sessionId: 's', cwd: '/repo' } })
    await expect(handlers.read({ panelId: 'term' }, ctx())).resolves.toMatchObject({
      panelId: 'term', session: { sessionId: 's' }, messages: [{ role: 'user', text: 'hello' }],
    })
    terminal.set('term-2', { status: 'running' })
    await expect(rpcError(handlers.read({ panelId: 'term-2' }, ctx()))).resolves.toBe('no-agent-session')
    await expect(rpcError(handlers.read({ panelId: 'none' }, ctx()))).resolves.toBe('agent-panel-not-found')
  })

  it('sends to the terminal and turns a refusal into an error', async () => {
    terminal.set('term', {})
    await expect(handlers.send({ targetPanelId: 'term', prompt: 'go' }, ctx())).resolves.toEqual({ ok: true })
    expect(terminal.terminals.send).toHaveBeenCalledWith('term', 'go')
    vi.mocked(terminal.terminals.send).mockResolvedValueOnce({ ok: false, error: 'agent-busy' })
    await expect(rpcError(handlers.send({ targetPanelId: 'term', prompt: 'go' }, ctx()))).resolves.toBe('agent-busy')
  })

  it('tells a terminal with no agent apart from a missing panel', async () => {
    terminal.set('idle-shell', { status: 'notRunning', present: false })
    await expect(rpcError(handlers.send({ targetPanelId: 'idle-shell', prompt: 'go' }, ctx()))).resolves.toMatch(/^no-agent-in-terminal/)
    await expect(rpcError(handlers.send({ targetPanelId: 'none', prompt: 'go' }, ctx()))).resolves.toBe('agent-panel-not-found')
  })

  it('lists a started agent as starting and waits for it until its CLI is up', async () => {
    vi.mocked(starter.starting).mockReturnValue([{ panelId: 'term', agentId: 'codex' }])
    expect(await handlers.list({}, ctx())).toEqual([
      { panelId: 'term', title: 'Backend', agentId: 'codex', agentName: 'Codex', state: 'starting', canReceivePrompt: false },
    ])
    await expect(rpcError(handlers.send({ targetPanelId: 'term', prompt: 'go' }, ctx()))).resolves.toMatch(/^agent-starting/)

    const waiting = handlers.wait({ panelIds: ['term'], timeoutSeconds: 5 }, ctx())
    vi.mocked(starter.starting).mockReturnValue([])
    terminal.set('term', { status: 'waitingForInput', canReceivePrompt: true })
    await expect(waiting).resolves.toMatchObject({ timedOut: false, agents: [{ panelId: 'term', state: 'waitingForInput' }] })
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
    await handlers.start({ prompt: 'Fix it', canvasPanelId: 'canvas', position: { x: 10, y: 20 } }, ctx())
    expect(starter.start).toHaveBeenCalledWith('supervisor', { prompt: 'Fix it', placement: { near: 'canvas', position: { x: 10, y: 20 } } })
  })

  it('leaves the place to the starter without a canvas, and starts for a client without a panel', async () => {
    await handlers.start({ prompt: 'Fix it', agentId: 'codex' }, ctx({ kind: 'client', panelId: undefined }))
    expect(starter.start).toHaveBeenCalledWith(undefined, { prompt: 'Fix it', agentId: 'codex' })
  })
})

describe('agents capability', () => {
  it('streams every agent panel\'s state as a snapshot, then changes', () => {
    terminal.set('term', {})
    const events: unknown[] = []
    const impl = agentsCapabilityImpl(agents, {} as never)
    const stop = impl.panels(undefined as never, { emit: (event: unknown) => events.push(event) } as never, {} as never)
    terminal.set('term-2', { status: 'running' })
    expect(events).toEqual([
      { kind: 'snapshot', rev: 0, snapshot: { term: expect.objectContaining({ panelId: 'term' }) } },
      { kind: 'change', rev: 1, change: { 'term-2': expect.objectContaining({ status: 'running' }) } },
    ])
    ;(stop as () => void)()
  })

  it('reports running agents as busy', () => {
    terminal.set('term', { status: 'running' })
    terminal.set('term-2', {})
    expect(agentsCapabilityImpl(agents, {} as never).busy(undefined as never, {} as never)).toEqual({ panelIds: ['term'] })
  })
})
