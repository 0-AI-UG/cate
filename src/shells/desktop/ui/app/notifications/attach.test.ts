import { afterEach, expect, it, vi } from 'vitest'
import type { ChannelEvent } from '@kernel/rpc/contract'
import { setRuntimeResolver } from '@kernel/rpc/client'
import type { AgentPanelStates, AgentPanelStatesChange, PanelAgentState } from '@services/agents/contract'
import { fakeStream } from '@services/agents/client/testing'
import { attachNotifications, type NotificationConnection } from './attach'
import type { NotificationDisplay, RuntimeNotification } from './display'

const panel = (status: PanelAgentState['status']): PanelAgentState => ({
  panelId: 'p1', runner: 'terminal', agentId: 'codex', agentName: 'Codex', status,
  present: true, canReceivePrompt: status !== 'running', session: null,
})

let stopResolver = () => {}
afterEach(() => stopResolver())

it('shows each workspace event, drops a pending one when its agent runs, and detaches', () => {
  const events = fakeStream<RuntimeNotification>()
  const panels = fakeStream<ChannelEvent<AgentPanelStates, AgentPanelStatesChange>>()
  const runtime = {
    agents: {
      notifications: vi.fn(() => events.sub),
      panels: vi.fn(() => panels.sub),
    },
  }
  stopResolver = setRuntimeResolver((id) => (id === 'ws' ? (runtime as never) : null))
  const connection: NotificationConnection = { workspaceId: 'ws', runtime }
  let list: NotificationConnection[] = [connection]
  const listeners = new Set<() => void>()
  const display: NotificationDisplay = { show: vi.fn(), cancel: vi.fn(), dispose: vi.fn() }

  const stop = attachNotifications({ getSnapshot: () => list, subscribe: (l) => { listeners.add(l); return () => listeners.delete(l) } }, display)
  expect(runtime.agents.notifications).toHaveBeenCalledWith(undefined, { resume: true })

  const event = { kind: 'agent.needsInput', panelId: 'p1', title: 't', body: 'b' }
  events.emit(event)
  expect(display.show).toHaveBeenCalledWith('ws', event)

  panels.emit({ kind: 'snapshot', rev: 1, snapshot: { p1: panel('waitingForInput') } })
  expect(display.cancel).not.toHaveBeenCalled()
  panels.emit({ kind: 'change', rev: 2, change: { p1: panel('running') } })
  expect(display.cancel).toHaveBeenCalledWith('ws', 'p1')

  list = []
  for (const l of listeners) l()
  expect(events.sub.cancel).toHaveBeenCalled()
  expect(panels.sub.cancel).toHaveBeenCalled()
  stop()
})
