import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { setRuntimeResolver } from '@kernel/rpc/client'
import type { ChannelEvent } from '@kernel/rpc/contract'
import type { AgentPanelStates, AgentPanelStatesChange, PanelAgentState } from '../contract'
import { fakeStream } from '../client/testing'
import { useAgentInfoByPanel, useAgentPanelTitle, type AgentPanelInfo } from './index'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let stop = () => {}
afterEach(() => stop())

const state = (patch: Partial<PanelAgentState> = {}): PanelAgentState => ({
  panelId: 'p1', runner: 'terminal', agentId: 'codex', agentName: 'Codex', status: 'running',
  present: true, canReceivePrompt: false, session: null, ...patch,
})

it('selects agent info from one shared stream and closes it on unmount', () => {
  const stream = fakeStream<ChannelEvent<AgentPanelStates, AgentPanelStatesChange>>()
  const runtime = { agents: { panels: vi.fn(() => stream.sub) } }
  stop = setRuntimeResolver((id) => (id === 'ws' ? (runtime as never) : null))

  const infos: Record<string, AgentPanelInfo>[] = []
  let title = ''
  function Probe() {
    infos.push(useAgentInfoByPanel('ws'))
    title = useAgentPanelTitle('ws', 'p1', 'Terminal')
    return null
  }
  const root = createRoot(document.createElement('div'))
  act(() => root.render(<Probe />))
  expect(runtime.agents.panels).toHaveBeenCalledTimes(1)
  expect(infos.at(-1)).toEqual({})

  act(() => stream.emit({ kind: 'snapshot', rev: 1, snapshot: { p1: state() } }))
  expect(infos.at(-1)?.p1).toMatchObject({ status: 'running', name: 'Codex' })
  expect(title).toBe('Codex')

  // An unrelated field change keeps the selected value, so no new object.
  const before = infos.at(-1)
  act(() => stream.emit({ kind: 'change', rev: 2, change: { p1: state({ canReceivePrompt: true }) } }))
  expect(infos.at(-1)).toBe(before)

  act(() => root.unmount())
  expect(stream.sub.cancel).toHaveBeenCalled()
})
