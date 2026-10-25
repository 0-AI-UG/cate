import { afterEach, describe, expect, it, vi } from 'vitest'
import { setRuntimeResolver } from '@kernel/rpc/client'
import { RpcError, type ChannelEvent } from '@kernel/rpc/contract'
import type { PowerState } from '@runtime/power/contract'
import { fakeStream } from '@services/agents/client/testing'
import type { AgentConversation, AgentConversationChange, AgentPanelStates, AgentPanelStatesChange, PanelAgentState } from '@services/agents/contract'
import type { NotificationEvent } from '@workspace/notifications/contract'
import type { MobileBridge, MobileNotification, MobileViewEvent } from '../contract'
import type { MobileClient } from './boot'
import { registerPanelDefinitions } from '@client/host'
import { PANEL_DEFINITIONS } from '@panels/definitions'
import { createActionHandlers, agentWorktreeName, wordsFor } from './actions'
import { NOT_TAKEN } from './chatTimeline'
import { createMobileAgents } from './agents'
import { createMobileConversations } from './conversations'
import { add, attachTestWorkspace, buildDocument } from '../../../test/clientWorkspace'
import { MAIN_WINDOW } from '@workspace/document/contract'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const state = (patch: Partial<PanelAgentState> = {}): PanelAgentState => ({
  panelId: 'p1', agentId: 'claude-code', agentName: 'Claude Code', label: 'Claude Code', contextPolicy: null, status: 'running',
  present: true, canReceivePrompt: false, session: { agentId: 'claude-code', sessionId: 's', cwd: '/repo/.cate/worktrees/a' }, ...patch,
})

function setup(options: { active?: boolean } = {}) {
  const panels = fakeStream<ChannelEvent<AgentPanelStates, AgentPanelStatesChange>>()
  const notifications = fakeStream<NotificationEvent>()
  const power = fakeStream<ChannelEvent<PowerState, Partial<PowerState>>>()
  const runtime = {
    agents: {
      panels: () => panels.sub,
      start: vi.fn(async () => ({ panelId: 'new', agentId: 'codex' })),
    },
    notifications: { events: () => notifications.sub },
    power: { subscribe: vi.fn(() => power.sub) },
    push: { register: vi.fn(async () => ({ registered: true, blocked: null })) },
  }
  const stopResolver = setRuntimeResolver((id) => (id === 'ws' ? (runtime as never) : null))
  let kind = 'connected'
  const connectionListeners = new Set<() => void>()
  const connection = {
    workspaceId: 'ws',
    runtime,
    getState: () => ({ kind }),
    subscribe: (listener: () => void) => {
      connectionListeners.add(listener)
      return () => { connectionListeners.delete(listener) }
    },
  }
  const setConnection = (next: string) => {
    kind = next
    for (const listener of [...connectionListeners]) listener()
  }
  const client = {
    connections: { getSnapshot: () => [connection], subscribe: () => () => {} },
    workspaces: { getSnapshot: () => ({ entries: [{ id: 'ws', kind: 'paired', runtimeId: 'rrrrrrrrrrrrrrrr' }] }) },
    settings: { get: (key: string) => ({ notificationsEnabled: true, notifyOnlyWhenUnfocused: true } as Record<string, boolean>)[key] },
    isActive: () => options.active ?? false,
  } as unknown as MobileClient
  const shown: MobileNotification[] = []
  const withdrawn: string[] = []
  const bridge = (async (method: string, params: MobileNotification) => {
    if (method === 'notification.show') shown.push(params)
    if (method === 'notification.withdraw') withdrawn.push((params as unknown as { id: string }).id)
    return null
  }) as MobileBridge
  const agents = createMobileAgents(client, bridge)
  // The document names each agent's panel.
  const ws = attachTestWorkspace('ws', buildDocument([add('p1', { to: 'stack', dock: { windowId: MAIN_WINDOW }, stackId: 's1' })]))
  const stop = () => { ws.detach(); stopResolver() }
  return { agents, panels, notifications, power, runtime, shown, withdrawn, stopResolver: stop, setConnection }
}

let cleanup = () => {}
afterEach(() => cleanup())

describe('mobile agents', () => {
  it('shows each agent with what it asked for, and hands its notification to the app', async () => {
    const t = setup()
    cleanup = t.stopResolver
    t.panels.emit({ kind: 'snapshot', rev: 0, snapshot: { p1: state() } })
    expect(t.agents.agents('ws')).toMatchObject([{ panelId: 'p1', status: 'running', attention: null, checkout: '/repo/.cate/worktrees/a' }])

    t.notifications.emit({ kind: 'agent.needsPermission', panelId: 'p1', title: 'Claude Code needs permission', body: 'Bash: npm test' })
    t.panels.emit({ kind: 'change', rev: 1, change: { p1: state({ status: 'waitingForInput' }) } })
    await tick()
    expect(t.agents.agents('ws')[0]).toMatchObject({ status: 'waitingForInput', attention: 'Bash: npm test' })
    await vi.waitFor(() => expect(t.shown).toHaveLength(1))
    expect(t.shown).toEqual([{
      id: 'rrrrrrrrrrrrrrrr.p1', workspaceId: 'ws', panelId: 'p1', kind: 'agent.needsPermission',
      title: 'Claude Code needs permission', body: 'Bash: npm test',
    }])

    // Back at work, the request is answered and its banner withdrawn.
    t.panels.emit({ kind: 'change', rev: 2, change: { p1: state({ status: 'running' }) } })
    expect(t.agents.agents('ws')[0].attention).toBeNull()
    expect(t.withdrawn).toEqual(['rrrrrrrrrrrrrrrr.p1'])
  })

  it('shows no banner while the app is in front, as notifyOnlyWhenUnfocused asks', async () => {
    const t = setup({ active: true })
    cleanup = t.stopResolver
    t.panels.emit({ kind: 'snapshot', rev: 0, snapshot: { p1: state({ status: 'waitingForInput' }) } })
    t.notifications.emit({ kind: 'agent.needsInput', panelId: 'p1', title: 'Claude Code needs input', body: 'Waiting.' })
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(t.shown).toEqual([])
    // What it asked for still shows on the agent.
    expect(t.agents.agents('ws')[0]).toMatchObject({ attention: 'Waiting.' })
  })

  it('reads keep-awake and this device\'s push registration', async () => {
    const t = setup()
    cleanup = t.stopResolver
    await tick()
    t.power.emit({ kind: 'snapshot', rev: 0, snapshot: { requested: true, endsAt: null, busy: false, holding: true } })
    expect(t.agents.power('ws')).toMatchObject({ requested: true, holding: true })

    expect(t.agents.push('ws')).toBeNull()
    t.agents.setPushDevice({ target: 'apns:sandbox:ab', key: 'k' })
    await tick()
    expect(t.runtime.push.register).toHaveBeenCalledWith({ target: 'apns:sandbox:ab', key: 'k' })
    expect(t.agents.push('ws')).toEqual({ registered: true, blocked: null })
  })

  it('opens keep-awake again on every connect, so a stream that failed before its first event recovers', () => {
    const t = setup()
    cleanup = t.stopResolver
    expect(t.runtime.power.subscribe).toHaveBeenCalledTimes(1)
    t.setConnection('incompatible')
    t.setConnection('connected')
    expect(t.runtime.power.subscribe).toHaveBeenCalledTimes(2)
    expect(t.power.sub.cancel).toHaveBeenCalled()
    t.power.emit({ kind: 'snapshot', rev: 0, snapshot: { requested: false, endsAt: null, busy: true, holding: true } })
    expect(t.agents.power('ws')).toMatchObject({ busy: true })
  })
})

describe('mobile actions', () => {
  it('follows a conversation as deltas, with the prompts the runtime keeps', async () => {
    const conversation = fakeStream<ChannelEvent<AgentConversation, AgentConversationChange>>()
    const send = vi.fn(async (_: unknown) => ({ promptId: 'a' }))
    const withdraw = vi.fn(async () => ({ prompt: 'later', attachments: ['/data/photo.jpg'] }))
    const interrupt = vi.fn(async () => { throw new Error('agent-not-running') })
    // Earlier tests' agent panel mirrors follow the resolver too.
    const runtime = { agents: { panels: () => fakeStream().sub, conversation: vi.fn(() => conversation.sub), send, withdraw, interrupt } }
    const cleanupResolver = setRuntimeResolver((id) => (id === 'ws' ? (runtime as never) : null))
    const events: MobileViewEvent[] = []
    const bridge = (async (method: string, params: { json: string }) => {
      if (method === 'view.event') events.push(JSON.parse(params.json) as MobileViewEvent)
      return null
    }) as MobileBridge
    try {
      const actions = createActionHandlers({} as never, createMobileConversations(bridge))
      await actions['agents.watch']({ viewId: 'v', workspaceId: 'ws', panelId: 'p1' })
      expect(runtime.agents.conversation).toHaveBeenCalledWith({ panelId: 'p1' }, { resume: true })
      conversation.emit({ kind: 'snapshot', rev: 0, snapshot: {
        status: 'waitingForInput',
        canReceivePrompt: true,
        messages: [{ role: 'user', text: 'Complete this coding task:\n\nSay hi', createdAt: '2026-01-01T00:00:01.000Z' }, { role: 'assistant', text: 'Hi.' }],
        steps: [],
        stepsSince: '2026-01-01T00:00:00.000Z',
        prompts: [],
      } })
      expect(events.at(-1)).toEqual({
        kind: 'chat', loaded: true, status: 'waitingForInput', canReceivePrompt: true, queued: [], failed: [], turn: null, from: 0,
        items: [
          { kind: 'prompt', id: 'm0', text: 'Say hi', sent: true },
          { kind: 'reply', id: 'm1', text: 'Hi.' },
        ],
      })

      await expect(actions['agents.send']({ workspaceId: 'ws', panelId: 'p1', prompt: 'go' })).resolves.toEqual({ ok: true })
      expect(send).toHaveBeenCalledWith({ panelId: 'p1', prompt: 'go' })
      // The runtime says it is on its way.
      conversation.emit({ kind: 'change', rev: 1, change: { prompts: [{ id: 'a', text: 'go', attachments: [], state: 'sending' }] } })
      expect(events.at(-1)).toMatchObject({ turn: { step: null }, from: 2, items: [{ kind: 'prompt', id: 'm2', text: 'go', sent: false }] })

      // Taken, and the turn shows with the prompt: one event, the same item sent.
      conversation.emit({ kind: 'change', rev: 2, change: {
        status: 'running', canReceivePrompt: false, prompts: [], from: 2, messages: [{ role: 'user', text: 'go', createdAt: '2026-01-01T00:00:02.000Z' }],
      } })
      expect(events.at(-1)).toEqual({
        kind: 'chat', loaded: true, status: 'running', canReceivePrompt: false, queued: [], failed: [], turn: { step: null }, from: 2,
        items: [{ kind: 'prompt', id: 'm2', text: 'go', sent: true }],
      })

      // A step of the running turn shows at its end and as what it is doing.
      const step = { tool: 'Bash', subject: 'npm test', at: '2026-01-01T00:00:05.000Z' }
      conversation.emit({ kind: 'change', rev: 3, change: { stepsFrom: 0, steps: [step] } })
      expect(events.at(-1)).toMatchObject({ from: 3, items: [{ kind: 'steps', id: 's3', steps: [step], ghost: false }], turn: { step } })

      // Sent while it works: the runtime keeps it queued and shows it to every chat.
      await expect(actions['agents.send']({ workspaceId: 'ws', panelId: 'p1', prompt: 'later', attachments: ['/data/photo.jpg'] }))
        .resolves.toEqual({ ok: true })
      expect(send).toHaveBeenLastCalledWith({ panelId: 'p1', prompt: 'later', attachments: ['/data/photo.jpg'] })
      conversation.emit({ kind: 'change', rev: 4, change: { prompts: [
        { id: 'q1', text: 'later', attachments: ['/data/photo.jpg'], state: 'queued' },
        { id: 'q2', text: '', attachments: ['/data/photo.jpg'], state: 'queued' },
      ] } })
      expect(events.at(-1)).toMatchObject({ queued: [{ id: 'q1', text: 'later' }, { id: 'q2', text: 'See the attached files.' }], from: 4, items: [] })
      await expect(actions['agents.withdraw']({ workspaceId: 'ws', panelId: 'p1', promptId: 'q1' }))
        .resolves.toEqual({ prompt: 'later', attachments: ['/data/photo.jpg'] })
      expect(withdraw).toHaveBeenCalledWith({ panelId: 'p1', promptId: 'q1' })

      // Not taken: the chat shows it failed, with what to do.
      conversation.emit({ kind: 'change', rev: 5, change: { prompts: [{ id: 'b', text: 'again', attachments: [], state: 'failed', error: 'agent-prompt-not-taken: no turn' }] } })
      expect(events.at(-1)).toMatchObject({ queued: [], failed: [{ id: 'b', text: 'again', message: NOT_TAKEN }] })
      // Refused only when no agent can take it.
      send.mockRejectedValueOnce(new RpcError('gone', 'agent-not-running'))
      await expect(actions['agents.send']({ workspaceId: 'ws', panelId: 'p1', prompt: 'again' }))
        .resolves.toEqual({ ok: false, message: 'The agent is not running.' })

      await expect(actions['agents.interrupt']({ workspaceId: 'ws', panelId: 'p1' }))
        .resolves.toEqual({ ok: false, message: 'The agent is not running.' })
      expect(interrupt).toHaveBeenCalledWith({ panelId: 'p1' })
      await actions['agents.unwatch']({ viewId: 'v' })
      expect(conversation.sub.cancel).toHaveBeenCalled()
    } finally {
      cleanupResolver()
    }
  })

  it('starts an agent through the agents capability, on the canvas picked', async () => {
    const t = setup()
    cleanup = t.stopResolver
    registerPanelDefinitions(PANEL_DEFINITIONS)
    const actions = createActionHandlers(t.agents, createMobileConversations((async () => null) as MobileBridge))
    const { width, height } = PANEL_DEFINITIONS.find((definition) => definition.type === 'terminal')!.defaultSize
    await expect(actions['agents.start']({
      workspaceId: 'ws', prompt: 'Fix it', agentId: 'codex', worktree: false,
      placement: { canvasPanelId: 'canvas', point: { x: 1000, y: 500 } },
    })).resolves.toEqual({ ok: true, panelId: 'new' })
    expect(t.runtime.agents.start).toHaveBeenLastCalledWith({
      prompt: 'Fix it', agentId: 'codex', canvasPanelId: 'canvas', position: { x: 1000 - width / 2, y: 500 - height / 2 },
    })
    await actions['agents.start']({ workspaceId: 'ws', prompt: 'Fix it', agentId: 'codex', worktree: true })
    expect(t.runtime.agents.start).toHaveBeenLastCalledWith({
      prompt: 'Fix it', agentId: 'codex', newWorktree: expect.stringMatching(/^agent-fix-it-/),
    })
    await actions['agents.start']({ workspaceId: 'ws', prompt: '', attachments: ['/data/photo.jpg'], agentId: 'codex', worktree: false })
    expect(t.runtime.agents.start).toHaveBeenLastCalledWith({ prompt: '', attachments: ['/data/photo.jpg'], agentId: 'codex' })
  })

  it('names a new agent worktree after its prompt', () => {
    expect(agentWorktreeName('Fix the flaky login test!', 'x1y2')).toBe('agent-fix-the-flaky-login-test-x1y2')
    expect(agentWorktreeName('???', 'x1y2')).toBe('agent-work-x1y2')
  })

  it('puts runtime error codes in words', () => {
    expect(wordsFor('agent-busy')).toBe('The agent is in the middle of a turn.')
    expect(wordsFor(new Error('agent-prompt-not-taken: the agent started no turn'))).toBe(NOT_TAKEN)
    expect(wordsFor(new Error('Something else'))).toBe('Something else')
  })
})
