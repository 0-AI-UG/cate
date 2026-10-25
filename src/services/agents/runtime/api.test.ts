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
    settings: { agentHookInjection: () => ({}), panelRelationsEnabled: () => true, usagePriceOverrides: () => ({}) },
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
      { panelId: 'term', title: 'Backend', agentId: 'codex', agentName: 'Codex', state: 'running', canReceivePrompt: false, prompts: [] },
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

  it('takes a prompt and shows its outcome as the panel\'s prompts', async () => {
    terminal.set('term', { status: 'running', canReceivePrompt: false })
    // Busy is no refusal: it waits for the agent.
    const { promptId } = await handlers.send({ targetPanelId: 'term', prompt: 'go' }, ctx()) as { promptId: string }
    expect(terminal.terminals.send).not.toHaveBeenCalled()
    expect(await handlers.list({}, ctx())).toMatchObject([{ panelId: 'term', prompts: [{ id: promptId, text: 'go', state: 'queued' }] }])
    // Typed and not taken: read shows it failed, with why.
    vi.mocked(terminal.terminals.send).mockResolvedValueOnce({ ok: false, error: 'agent-prompt-not-taken', typed: true })
    terminal.set('term', { status: 'waitingForInput', canReceivePrompt: true, session: { agentId: 'codex', sessionId: 's', cwd: '/repo' } })
    expect(terminal.terminals.send).toHaveBeenCalledWith('term', 'go', [])
    await vi.waitFor(async () => expect((await handlers.read({ panelId: 'term' }, ctx()) as { prompts: unknown }).prompts)
      .toEqual([{ id: promptId, text: 'go', state: 'failed', error: 'agent-prompt-not-taken' }]))
    // Refused only when nothing could ever take it.
    terminal.set('gone', { status: 'waitingForInput', present: false })
    await expect(rpcError(handlers.send({ targetPanelId: 'gone', prompt: 'go' }, ctx()))).resolves.toBe('agent-not-running')
  })

  it('sends from the CLI and from a client through the same function, with the same result', async () => {
    terminal.set('term', { status: 'running', canReceivePrompt: false })
    const impl = agentsCapabilityImpl(agents, starter, {} as never)
    const fromCli = await handlers.send({ targetPanelId: 'term', prompt: 'one' }, ctx()) as { promptId: string }
    const fromClient = await impl.send({ panelId: 'term', prompt: 'two' }, {} as never)
    expect(Object.keys(fromCli)).toEqual(['promptId'])
    expect(Object.keys(fromClient)).toEqual(['promptId'])
    expect(agents.prompts.of('term').map((prompt) => [prompt.id, prompt.text, prompt.state]))
      .toEqual([[fromCli.promptId, 'one', 'queued'], [fromClient.promptId, 'two', 'queued']])
    // And both refuse an agent that is still starting the same way.
    vi.mocked(starter.starting).mockReturnValue([{ panelId: 'term', agentId: 'codex' }])
    await expect(rpcError(handlers.send({ targetPanelId: 'term', prompt: 'go' }, ctx()))).resolves.toMatch(/^agent-starting/)
    await expect(rpcError(Promise.resolve().then(() => impl.send({ panelId: 'term', prompt: 'go' }, {} as never)))).resolves.toMatch(/^agent-starting/)
  })

  it('takes a prompt back from the CLI and from a client through the same function', async () => {
    terminal.set('term', { status: 'running', canReceivePrompt: false })
    const impl = agentsCapabilityImpl(agents, starter, {} as never)
    const one = await handlers.send({ targetPanelId: 'term', prompt: 'one' }, ctx()) as { promptId: string }
    const two = await impl.send({ panelId: 'term', prompt: 'two', attachments: ['/data/photo.jpg'] }, {} as never)
    await expect(handlers.withdraw({ targetPanelId: 'term', promptId: two.promptId }, ctx())).resolves.toEqual({ prompt: 'two', attachments: ['/data/photo.jpg'] })
    await expect(Promise.resolve(impl.withdraw({ panelId: 'term', promptId: one.promptId }, {} as never))).resolves.toEqual({ prompt: 'one', attachments: [] })
    expect(agents.prompts.of('term')).toEqual([])
    await expect(rpcError(handlers.withdraw({ targetPanelId: 'term', promptId: one.promptId }, ctx()))).resolves.toBe('prompt-not-found')
    await expect(rpcError(Promise.resolve().then(() => impl.withdraw({ panelId: 'term', promptId: one.promptId }, {} as never)))).resolves.toBe('prompt-not-found')
  })

  it('waits until the prompts sent went out, or one was not taken', async () => {
    terminal.set('term', { status: 'running', canReceivePrompt: false })
    await handlers.send({ targetPanelId: 'term', prompt: 'go' }, ctx())
    let done = false
    const waiting = handlers.wait({ panelIds: ['term'], timeoutSeconds: 5 }, ctx())
    void Promise.resolve(waiting).then(() => { done = true })
    let settle = (_: { ok: false; error: string; typed: true }) => {}
    vi.mocked(terminal.terminals.send).mockImplementationOnce(() => new Promise((resolve) => { settle = resolve }))
    terminal.set('term', { status: 'waitingForInput', canReceivePrompt: true })
    // At its prompt, but the prompt is on its way: not ready yet.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(done).toBe(false)
    settle({ ok: false, error: 'agent-prompt-not-taken', typed: true })
    await expect(waiting).resolves.toMatchObject({ timedOut: false, agents: [{ prompts: [{ text: 'go', state: 'failed' }] }] })
  })

  it('tells a terminal with no agent apart from a missing panel', async () => {
    terminal.set('idle-shell', { status: 'notRunning', present: false })
    await expect(rpcError(handlers.send({ targetPanelId: 'idle-shell', prompt: 'go' }, ctx()))).resolves.toMatch(/^no-agent-in-terminal/)
    await expect(rpcError(handlers.send({ targetPanelId: 'none', prompt: 'go' }, ctx()))).resolves.toBe('agent-panel-not-found')
  })

  it('lists a started agent as starting and waits for it until its CLI is up', async () => {
    vi.mocked(starter.starting).mockReturnValue([{ panelId: 'term', agentId: 'codex' }])
    expect(await handlers.list({}, ctx())).toEqual([
      { panelId: 'term', title: 'Backend', agentId: 'codex', agentName: 'Codex', state: 'starting', canReceivePrompt: false, prompts: [] },
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
    const impl = agentsCapabilityImpl(agents, {} as never, {} as never)
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
    expect(agentsCapabilityImpl(agents, {} as never, {} as never).busy(undefined as never, {} as never)).toEqual({ panelIds: ['term'] })
  })
})
