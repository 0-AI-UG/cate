import { afterEach, describe, expect, it, vi } from 'vitest'
import { setRuntimeResolver } from '@kernel/rpc/client'
import type { ChannelEvent } from '@kernel/rpc/contract'
import type { PowerState } from '@runtime/power/contract'
import { fakeStream } from '@services/agents/client/testing'
import type { AgentNotificationEvent, AgentPanelStates, AgentPanelStatesChange, PanelAgentState } from '@services/agents/contract'
import type { MobileBridge, MobileNotification } from '../contract'
import type { MobileClient } from './boot'
import { createActionHandlers, taskWorktreeName, wordsFor } from './actions'
import { createMobileAgents } from './agents'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const state = (patch: Partial<PanelAgentState> = {}): PanelAgentState => ({
  panelId: 'p1', runner: 'terminal', agentId: 'claude-code', agentName: 'Claude Code', status: 'running',
  present: true, canReceivePrompt: false, session: { agentId: 'claude-code', runner: 'terminal', sessionId: 's', cwd: '/repo/.cate/worktrees/a' }, ...patch,
})

function setup() {
  const panels = fakeStream<ChannelEvent<AgentPanelStates, AgentPanelStatesChange>>()
  const notifications = fakeStream<AgentNotificationEvent>()
  const power = fakeStream<ChannelEvent<PowerState, Partial<PowerState>>>()
  const runtime = {
    agents: {
      panels: () => panels.sub,
      notifications: () => notifications.sub,
    },
    api: {
      call: vi.fn(async () => [{ id: 'run-1', agentId: 'claude-code', agentName: 'Claude Code', panelId: 'p1', status: 'working', cwd: '/repo/.cate/worktrees/a', alive: true, followUpSupported: true, worktreeId: 'w', ownsWorktree: true, background: true }]),
    },
    power: { subscribe: () => power.sub },
    push: { register: vi.fn(async () => ({ registered: true, blocked: null })) },
  }
  const stopResolver = setRuntimeResolver((id) => (id === 'ws' ? (runtime as never) : null))
  const connection = { workspaceId: 'ws', runtime, getState: () => ({ kind: 'connected' }), subscribe: () => () => {} }
  const client = {
    connections: { getSnapshot: () => [connection], subscribe: () => () => {} },
    workspaces: { getSnapshot: () => ({ entries: [{ id: 'ws', kind: 'paired', runtimeId: 'rrrrrrrrrrrrrrrr' }] }) },
  } as unknown as MobileClient
  const shown: MobileNotification[] = []
  const withdrawn: string[] = []
  const bridge = (async (method: string, params: MobileNotification) => {
    if (method === 'notification.show') shown.push(params)
    if (method === 'notification.withdraw') withdrawn.push((params as unknown as { id: string }).id)
    return null
  }) as MobileBridge
  const agents = createMobileAgents(client, bridge)
  return { agents, panels, notifications, power, runtime, shown, withdrawn, stopResolver }
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
    expect(t.shown).toEqual([{
      id: 'rrrrrrrrrrrrrrrr.p1', workspaceId: 'ws', panelId: 'p1', kind: 'agent.needsPermission',
      title: 'Claude Code needs permission', body: 'Bash: npm test',
    }])

    // Back at work, the request is answered and its banner withdrawn.
    t.panels.emit({ kind: 'change', rev: 2, change: { p1: state({ status: 'running' }) } })
    expect(t.agents.agents('ws')[0].attention).toBeNull()
    expect(t.withdrawn).toEqual(['rrrrrrrrrrrrrrrr.p1'])
  })

  it('reads the workers, keep-awake and this device\'s push registration', async () => {
    const t = setup()
    cleanup = t.stopResolver
    await tick()
    expect(t.runtime.api.call).toHaveBeenCalledWith({ method: 'cate.codingAgent.list', args: {} })
    expect(t.agents.tasks('ws')).toMatchObject([{ id: 'run-1', status: 'working', isolated: true, ownsWorktree: true }])
    t.power.emit({ kind: 'snapshot', rev: 0, snapshot: { requested: true, endsAt: null, busy: false, holding: true } })
    expect(t.agents.power('ws')).toMatchObject({ requested: true, holding: true })

    expect(t.agents.push('ws')).toBeNull()
    t.agents.setPushDevice({ target: 'apns:sandbox:ab', key: 'k' })
    await tick()
    expect(t.runtime.push.register).toHaveBeenCalledWith({ target: 'apns:sandbox:ab', key: 'k' })
    expect(t.agents.push('ws')).toEqual({ registered: true, blocked: null })
  })
})

describe('mobile actions', () => {
  it('reads and prompts an agent through cate.agent.*', async () => {
    const call = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'cate.agent.read') return { messages: [{ role: 'assistant', text: 'Done.' }] }
      throw new Error('agent-busy')
    })
    // Earlier tests' agent panel mirrors follow the resolver too.
    const runtime = { api: { call }, agents: { panels: () => fakeStream().sub } }
    const cleanupResolver = setRuntimeResolver((id) => (id === 'ws' ? (runtime as never) : null))
    try {
      const actions = createActionHandlers({} as never)
      await expect(actions['agents.conversation']({ workspaceId: 'ws', panelId: 'p1' })).resolves.toEqual([{ role: 'assistant', text: 'Done.' }])
      expect(call).toHaveBeenCalledWith({ method: 'cate.agent.read', args: { panelId: 'p1' } })
      await expect(actions['agents.send']({ workspaceId: 'ws', panelId: 'p1', prompt: 'go' }))
        .resolves.toEqual({ ok: false, message: 'The agent is in the middle of a turn.' })
      expect(call).toHaveBeenCalledWith({ method: 'cate.agent.send', args: { targetPanelId: 'p1', prompt: 'go' } })
    } finally {
      cleanupResolver()
    }
  })

  it('names a task worktree after the prompt', () => {
    expect(taskWorktreeName('Fix the flaky login test!', 'x1y2')).toBe('task-fix-the-flaky-login-test-x1y2')
    expect(taskWorktreeName('???', 'x1y2')).toBe('task-work-x1y2')
  })

  it('puts runtime error codes in words', () => {
    expect(wordsFor(new Error('coding-agent-limit'))).toBe('Five tasks are already running. Wait for one to finish.')
    expect(wordsFor('agent-busy')).toBe('The agent is in the middle of a turn.')
    expect(wordsFor(new Error('Something else'))).toBe('Something else')
  })
})
