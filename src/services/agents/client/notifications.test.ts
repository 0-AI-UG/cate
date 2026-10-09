import { afterEach, expect, it, vi } from 'vitest'
import type { ChannelEvent } from '@kernel/rpc/contract'
import { setRuntimeResolver } from '@kernel/rpc/client'
import type { AgentNotificationEvent, AgentPanelStates, AgentPanelStatesChange, PanelAgentState } from '../contract'
import { attachAgentNotifications, type NotificationConnection, type NotificationDisplay } from './notifications'
import { fakeStream } from './testing'

const panel = (status: PanelAgentState['status']): PanelAgentState => ({
  panelId: 'p1', agentId: 'codex', agentName: 'Codex', label: 'Codex', takesOverPanel: true, contextPolicy: null, status,
  present: true, canReceivePrompt: status !== 'running', session: null,
})

let stopResolver = () => {}
afterEach(() => stopResolver())

it('shows each workspace event, drops a pending one when its agent runs, and detaches', () => {
  const events = fakeStream<AgentNotificationEvent>()
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
  const display: NotificationDisplay = { show: vi.fn(), cancel: vi.fn() }

  const stop = attachAgentNotifications({ getSnapshot: () => list, subscribe: (l) => { listeners.add(l); return () => listeners.delete(l) } }, display)
  expect(runtime.agents.notifications).toHaveBeenCalledWith(undefined, { resume: true })

  const event: AgentNotificationEvent = { kind: 'agent.needsInput', panelId: 'p1', title: 't', body: 'b' }
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
