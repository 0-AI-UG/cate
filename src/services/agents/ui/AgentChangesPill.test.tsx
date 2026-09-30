import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setRuntimeResolver } from '@kernel/rpc/client'
import type { ChannelEvent } from '@kernel/rpc/contract'
import type { AgentPanelStates, AgentPanelStatesChange } from '../contract'
import { acquireAgentPanels } from '../client'
import { fakeStream } from '../client/testing'
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

function render(props: { checkout?: string } = {}) {
  const host = document.createElement('div')
  const root = createRoot(host)
  act(() => root.render(<AgentChangesPill workspaceId="ws" panelId="agent" {...props} />))
  const click = () => act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Open agent changes"]')!.click() })
  return { host, click, unmount: () => act(() => root.unmount()) }
}

it('does not reserve label spacing while collapsed', () => {
  const { host, unmount } = render()
  const button = host.querySelector<HTMLButtonElement>('[aria-label="Open agent changes"]')!
  expect(button.classList).toContain('gap-0')
  expect(button.classList).toContain('hover:gap-1')
  unmount()
})

it('opens the changes in the workspace root without a known checkout', async () => {
  const { click, unmount } = render()
  await click()
  expect(open).toHaveBeenCalledWith({ workspaceId: 'ws', panelId: 'agent', cwd: '/repo' })
  unmount()
})

it("prefers the agent session's checkout, then the caller's", async () => {
  const { click, unmount } = render({ checkout: '/repo/wt' })
  await click()
  expect(open).toHaveBeenLastCalledWith({ workspaceId: 'ws', panelId: 'agent', cwd: '/repo/wt' })

  const handle = acquireAgentPanels('ws')
  panels.emit({ kind: 'snapshot', rev: 1, snapshot: { agent: {
    panelId: 'agent', runner: 't3', agentId: 'codex', agentName: 'Codex', status: 'finished', present: true, canReceivePrompt: true,
    session: { agentId: 'codex', runner: 't3', sessionId: 'thread', cwd: '/repo/other' },
  } } })
  await click()
  expect(open).toHaveBeenLastCalledWith({ workspaceId: 'ws', panelId: 'agent', cwd: '/repo/other' })
  handle.release()
  unmount()
})

it('shows an error when opening fails', async () => {
  open.mockResolvedValueOnce(false)
  const { host, click, unmount } = render()
  await click()
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Could not open agent changes')
  unmount()
})
