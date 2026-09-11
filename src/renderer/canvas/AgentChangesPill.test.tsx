import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { PanelState } from '../../shared/types'

const h = vi.hoisted(() => ({ open: vi.fn(async () => true) }))
vi.mock('../lib/review/openAgentChanges', () => ({ openAgentChanges: h.open }))
vi.mock('../stores/appStore', () => ({ useAppStore: { getState: () => ({ getWorkspace: () => ({ rootPath: '/repo' }) }) } }))
import { AgentChangesPill } from './AgentChangesPill'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

it('does not reserve label spacing while the changes chip is collapsed', () => {
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    act(() => root.render(<AgentChangesPill panel={{ id: 'panel', type: 'agent', title: 'Agent' } as PanelState} workspaceId="ws" />))
    const button = host.querySelector<HTMLButtonElement>('[aria-label="Open agent changes"]')!
    expect(button.classList).toContain('gap-0')
    expect(button.classList).toContain('hover:gap-1')
  } finally { act(() => root.unmount()) }
})

it.each(['terminal', 'agent'] as const)('opens the same panel-filtered picker from a %s chip', async (type) => {
  h.open.mockClear()
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    act(() => root.render(<AgentChangesPill panel={{ id: 'panel', type, title: 'Agent' } as PanelState} workspaceId="ws" />))
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Open agent changes"]')!.click() })
    expect(h.open).toHaveBeenCalledWith({ workspaceId: 'ws', panelId: 'panel', cwd: '/repo' })
  } finally { act(() => root.unmount()) }
})
