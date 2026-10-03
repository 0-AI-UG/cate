import { afterEach, describe, expect, it, vi } from 'vitest'
import { notifyRuntimesChanged, setRuntimeResolver } from '@kernel/rpc/client'
import type { ChannelEvent } from '@kernel/rpc/contract'
import type { AgentPanelStates, AgentPanelStatesChange, PanelAgentState } from '../contract'
import { acquireAgentPanels, cliAgentByPanel, cliAgentOpenByPanel, peekAgentPanels } from './panelStates'
import { fakeStream } from './testing'

type PanelsEvent = ChannelEvent<AgentPanelStates, AgentPanelStatesChange>

const state = (patch: Partial<PanelAgentState> = {}): PanelAgentState => ({
  panelId: 'p1', runner: 'terminal', agentId: 'codex', agentName: 'Codex', status: 'running',
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
    streams[0].emit({ kind: 'change', rev: 2, change: { p2: state({ panelId: 'p2', runner: 't3' }), p1: null } })
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

describe('terminal CLI selectors', () => {
  it('report the open agent of terminal panels only', () => {
    const states: AgentPanelStates = {
      t1: state({ panelId: 't1' }),
      t2: state({ panelId: 't2', present: false }),
      c1: state({ panelId: 'c1', runner: 't3' }),
    }
    expect(cliAgentOpenByPanel(states)).toEqual({ t1: true, t2: false })
    // An exited agent keeps its id but is not open.
    expect(cliAgentByPanel(states)).toEqual({ t1: 'codex', t2: null })
  })
})
