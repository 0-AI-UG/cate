import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { PANEL_DEFINITIONS } from '../../shared/panels'
const h = vi.hoisted(() => ({
  canvas: {
    nodes: {
      one: { id: 'one', origin: { x: 0, y: 0 }, size: { width: 600, height: 400 }, dockLayout: { type: 'tabs', id: 'one', panelIds: ['editor'], activeIndex: 0 } },
      two: { id: 'two', origin: { x: 700, y: 0 }, size: { width: 600, height: 400 }, dockLayout: { type: 'tabs', id: 'two', panelIds: ['review'], activeIndex: 0 } },
    },
    zoomLevel: 1, containerSize: { width: 1000, height: 800 }, viewportOffset: { x: 0, y: 0 },
  },
}))
vi.mock('../stores/CanvasStoreContext', () => ({
  useCanvasStoreContext: (select: any) => select(h.canvas), shallow: undefined,
  useCanvasStoreApi: () => ({ getState: () => h.canvas, subscribe: () => () => {} }),
}))
vi.mock('../stores/appStore', () => ({
  useAppStore: (select: any) => select({ selectedWorkspaceId: 'ws' }),
  useWorkspacePanels: () => ({ editor: { type: 'editor' }, review: { type: 'review' } }),
}))
vi.mock('../hooks/useAgentPanelInfo', () => ({ useAgentInfoByPanel: () => ({}) }))
vi.mock('./worktree/useWorktreeMembership', () => ({ useWorktreeMembership: () => ({ groups: [] }) }))
import Minimap from './Minimap'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
it('uses registered document and review colors in the minimap', () => {
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    act(() => root.render(<Minimap />))
    const colors = [...host.querySelectorAll<HTMLElement>('[style]')].map(element => element.style.backgroundColor)
    for (const type of ['editor', 'review'] as const) {
      expect(colors).toContain(`var(--panel-${type}, ${PANEL_DEFINITIONS[type].mutedColor})`)
    }
  } finally { act(() => root.unmount()) }
})
