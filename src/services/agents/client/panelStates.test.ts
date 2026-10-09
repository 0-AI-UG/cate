import { afterEach, describe, expect, it, vi } from 'vitest'
import { notifyRuntimesChanged, setRuntimeResolver } from '@kernel/rpc/client'
import type { ChannelEvent } from '@kernel/rpc/contract'
import type { AgentPanelStates, AgentPanelStatesChange, PanelAgentState } from '../contract'
import { acquireAgentPanels, peekAgentPanels } from './panelStates'
import { fakeStream } from './testing'

type PanelsEvent = ChannelEvent<AgentPanelStates, AgentPanelStatesChange>

const state = (patch: Partial<PanelAgentState> = {}): PanelAgentState => ({
  panelId: 'p1', agentId: 'codex', agentName: 'Codex', label: 'Codex', takesOverPanel: true, contextPolicy: null, status: 'running',
  present: true, canReceivePrompt: false, session: null, ...patch,
})

function fakeRuntime() {
  const streams: ReturnType<typeof fakeStream<PanelsEvent>>[] = []
  const runtime = {
    agents: {
      panels: vi.fn(() => {
        const stream = fakeStream<PanelsEvent>()
        streams.push(stream)
        return stream.sub
      }),
    },
  }
  return { runtime, streams }
}

let stop = () => {}
afterEach(() => stop())

describe('agent panel states', () => {
  it('shares one subscription per workspace and closes it on the last release', () => {
    const { runtime, streams } = fakeRuntime()
    stop = setRuntimeResolver((id) => (id === 'ws' ? (runtime as never) : null))
    const a = acquireAgentPanels('ws')
    const b = acquireAgentPanels('ws')
    expect(runtime.agents.panels).toHaveBeenCalledTimes(1)
    expect(runtime.agents.panels).toHaveBeenCalledWith(undefined, { resume: true })

    const seen = vi.fn()
    b.subscribe(seen)
    streams[0].emit({ kind: 'snapshot', rev: 1, snapshot: { p1: state() } })
    streams[0].emit({ kind: 'change', rev: 2, change: { p2: state({ panelId: 'p2', takesOverPanel: false }), p1: null } })
    expect(Object.keys(a.getSnapshot())).toEqual(['p2'])
    expect(peekAgentPanels('ws')).toBe(a.getSnapshot())
    expect(seen).toHaveBeenCalledTimes(2)

    a.release()
    a.release()
    expect(streams[0].sub.cancel).not.toHaveBeenCalled()
    b.release()
    expect(streams[0].sub.cancel).toHaveBeenCalled()
    expect(peekAgentPanels('ws')).toEqual({})
  })

  it('waits for the runtime and reopens when it changes', () => {
    const first = fakeRuntime()
    let current: unknown = null
    stop = setRuntimeResolver(() => current as never)
    const handle = acquireAgentPanels('ws')
    expect(handle.getSnapshot()).toEqual({})

    current = first.runtime
    notifyRuntimesChanged()
    first.streams[0].emit({ kind: 'snapshot', rev: 1, snapshot: { p1: state() } })
    expect(Object.keys(handle.getSnapshot())).toEqual(['p1'])

    const second = fakeRuntime()
    current = second.runtime
    notifyRuntimesChanged()
    expect(first.streams[0].sub.cancel).toHaveBeenCalled()
    expect(handle.getSnapshot()).toEqual({})
    expect(second.runtime.agents.panels).toHaveBeenCalledTimes(1)
    handle.release()
  })
})

