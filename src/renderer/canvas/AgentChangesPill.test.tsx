import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { PanelState } from '../../shared/types'

const h = vi.hoisted(() => ({ open: vi.fn(async () => true) }))
vi.mock('../lib/review/openAgentChanges', () => ({ openAgentChanges: h.open }))
vi.mock('../stores/appStore', () => ({ useAppStore: { getState: () => ({ getWorkspace: () => ({ rootPath: '/repo' }) }) } }))
import { AgentChangesPill } from './AgentChangesPill'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
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
