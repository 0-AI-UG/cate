import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setRuntimeResolver } from '@kernel/rpc/client'
import type { ChannelEvent } from '@kernel/rpc/contract'
import type { AgentPanelStates, AgentPanelStatesChange } from '@services/agents/contract'
import { fakeStream } from '@services/agents/client/testing'
import { AgentChangesPill } from './AgentChangesPill'
import { setAgentChangesOpener } from './changesOpener'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const open = vi.fn(async () => true)
const panels = fakeStream<ChannelEvent<AgentPanelStates, AgentPanelStatesChange>>()
let cleanup: (() => void)[] = []

beforeEach(() => {
  open.mockClear()
  const runtime = {
    workspace: { info: async () => ({ runtimeId: 'r', root: '/repo', name: 'repo' }) },
    agents: { panels: () => panels.sub },
  }
  cleanup = [setRuntimeResolver((id) => (id === 'ws' ? (runtime as never) : null)), setAgentChangesOpener(open)]
})

afterEach(() => { for (const stop of cleanup) stop() })

function render() {
  const host = document.createElement('div')
  const root = createRoot(host)
  act(() => root.render(<AgentChangesPill workspaceId="ws" panelId="agent" />))
  const click = () => act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Open agent changes"]')!.click() })
  return { host, click, unmount: () => act(() => root.unmount()) }
}

it('opens the agent panel\'s changes; the opener finds its checkout', async () => {
  const { click, unmount } = render()
  await click()
  expect(open).toHaveBeenCalledWith({ workspaceId: 'ws', panelId: 'agent' })
  unmount()
})

it('shows an error when opening fails', async () => {
  open.mockResolvedValueOnce(false)
  const { host, click, unmount } = render()
  await click()
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Could not open agent changes')
  unmount()
})
