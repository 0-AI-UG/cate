import { afterEach, expect, it, vi } from 'vitest'
import type { ChannelEvent } from '@kernel/rpc/contract'
import { setRuntimeResolver } from '@kernel/rpc/client'
import type { AgentPanelStates, AgentPanelStatesChange, PanelAgentState } from '../contract'
import { onAgentsWorking } from './working'
import { fakeStream } from './testing'

const panel = (status: PanelAgentState['status']): PanelAgentState => ({
  panelId: 'p1', agentId: 'codex', agentName: 'Codex', label: 'Codex', takesOverPanel: true, contextPolicy: null, status,
  present: true, canReceivePrompt: status !== 'running', session: null,
})

let stopResolver = () => {}
afterEach(() => stopResolver())

it('tells when a panel\'s agent works again, per open workspace, and detaches', () => {
  const panels = fakeStream<ChannelEvent<AgentPanelStates, AgentPanelStatesChange>>()
  const runtime = { agents: { panels: vi.fn(() => panels.sub) } }
  stopResolver = setRuntimeResolver((id) => (id === 'ws' ? (runtime as never) : null))
  let list = [{ workspaceId: 'ws' }]
  const listeners = new Set<() => void>()
  const working = vi.fn()

  const stop = onAgentsWorking({ getSnapshot: () => list, subscribe: (l) => { listeners.add(l); return () => listeners.delete(l) } }, working)
  panels.emit({ kind: 'snapshot', rev: 1, snapshot: { p1: panel('waitingForInput') } })
  expect(working).not.toHaveBeenCalled()
  panels.emit({ kind: 'change', rev: 2, change: { p1: panel('running') } })
  expect(working).toHaveBeenCalledWith('ws', 'p1')

  list = []
  for (const l of listeners) l()
  expect(panels.sub.cancel).toHaveBeenCalled()
  stop()
})
