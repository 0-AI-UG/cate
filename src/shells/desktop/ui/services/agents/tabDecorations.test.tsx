import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installClientUi } from '@kernel/interaction'
import { setRuntimeResolver } from '@kernel/rpc/client'
import type { ChannelEvent } from '@kernel/rpc/contract'
import type { AgentPanelStates, AgentPanelStatesChange } from '@services/agents/contract'
import { fakeStream } from '@services/agents/client/testing'
import type { PanelRecord } from '@workspace/document/contract'
import { AgentHooksOffOverlay } from './tabDecorations'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const panels = fakeStream<ChannelEvent<AgentPanelStates, AgentPanelStatesChange>>()
let stopResolver = () => {}
beforeEach(() => { stopResolver = setRuntimeResolver((id) => (id === 'ws' ? ({ agents: { panels: () => panels.sub } } as never) : null)) })
afterEach(() => stopResolver())

it('warns while the agent runs without Cate hooks and opens the hooks settings', () => {
  const openSettings = vi.fn()
  installClientUi({ openSettings } as never)
  const host = document.createElement('div')
  const root = createRoot(host)
  act(() => root.render(<AgentHooksOffOverlay workspaceId="ws" record={{ id: 'term' } as PanelRecord} />))
  expect(host.textContent).toBe('')

  const state = { panelId: 'term', agentId: 'claude-code', agentName: 'Claude Code', label: 'Claude Code', takesOverPanel: true, contextPolicy: null, status: 'running', present: true, canReceivePrompt: false, session: null } as const
  act(() => panels.emit({ kind: 'snapshot', rev: 1, snapshot: { term: { ...state, hooksMissing: true } } }))
  expect(host.textContent).toBe('Hooks off')
  act(() => host.querySelector('button')!.click())
  expect(openSettings).toHaveBeenCalledWith('hooks')

  act(() => panels.emit({ kind: 'snapshot', rev: 2, snapshot: { term: state } }))
  expect(host.textContent).toBe('')
  act(() => root.unmount())
})
