// =============================================================================
// Regression: bulk delete (Delete key / "Close All" on a multi-node selection)
// must use closePanelWithConfirm for every panel, matching normal panel closes
// (including dirty-editor, running-terminal, and canvas confirmation flows).
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'

const closePanelWithConfirm = vi.fn()
const SELECTED_WS = 'ws-1'

vi.mock('../appStore', () => ({
  useAppStore: {
    getState: () => ({ selectedWorkspaceId: SELECTED_WS }),
  },
}))

vi.mock('../../lib/closePanelWithConfirm', () => ({ closePanelWithConfirm }))

import { createCanvasStore } from '../canvasStore'
import type { DockLayoutNode } from '../../../shared/types'

function tabs(panelIds: string[]): DockLayoutNode {
  return { type: 'tabs', id: `stack-${panelIds.join('-')}`, panelIds, activeIndex: 0 }
}

describe('deleteSelection routes panel-backed nodes through closePanelWithConfirm', () => {
  beforeEach(() => {
    closePanelWithConfirm.mockReset()
    closePanelWithConfirm.mockResolvedValue(true)
  })

  it('closes every selected single-panel node through the normal close path', async () => {
    const store = createCanvasStore()
    const a = store.getState().addNode('term-a', 'terminal', { x: 0, y: 0 }, { width: 100, height: 80 })
    const b = store.getState().addNode('term-b', 'terminal', { x: 200, y: 0 }, { width: 100, height: 80 })

    store.getState().selectNodes([a, b])
    await store.getState().deleteSelection()

    expect(closePanelWithConfirm).toHaveBeenNthCalledWith(1, SELECTED_WS, 'term-a')
    expect(closePanelWithConfirm).toHaveBeenNthCalledWith(2, SELECTED_WS, 'term-b')
    expect(closePanelWithConfirm).toHaveBeenCalledTimes(2)

    // Nodes are still removed from the canvas as before.
    store.getState().finalizeRemoveNode(a)
    store.getState().finalizeRemoveNode(b)
    expect(store.getState().nodes[a]).toBeUndefined()
    expect(store.getState().nodes[b]).toBeUndefined()
    expect(store.getState().selection.length).toBe(0)
  })

  it('closes EVERY panel inside a multi-panel node (dock layout with several tabs)', async () => {
    const store = createCanvasStore()
    const node = store.getState().addNode('p1', 'terminal', { x: 0, y: 0 }, { width: 100, height: 80 })
    // Simulate the node hosting a 3-tab mini-dock (split/tabbed into it).
    store.getState().setNodeDockLayout(node, tabs(['p1', 'p2', 'p3']))

    store.getState().selectNodes([node])
    await store.getState().deleteSelection()

    expect(closePanelWithConfirm).toHaveBeenNthCalledWith(1, SELECTED_WS, 'p1')
    expect(closePanelWithConfirm).toHaveBeenNthCalledWith(2, SELECTED_WS, 'p2')
    expect(closePanelWithConfirm).toHaveBeenNthCalledWith(3, SELECTED_WS, 'p3')
    expect(closePanelWithConfirm).toHaveBeenCalledTimes(3)
  })

  it('keeps the selection intact when a normal close is cancelled', async () => {
    const store = createCanvasStore()
    const a = store.getState().addNode('term-a', 'terminal', { x: 0, y: 0 }, { width: 100, height: 80 })
    const b = store.getState().addNode('term-b', 'terminal', { x: 200, y: 0 }, { width: 100, height: 80 })
    closePanelWithConfirm.mockResolvedValueOnce(false)

    store.getState().selectNodes([a, b])
    await store.getState().deleteSelection()

    expect(closePanelWithConfirm).toHaveBeenCalledTimes(1)
    expect(store.getState().nodes[a].animationState).not.toBe('exiting')
    expect(store.getState().nodes[b].animationState).not.toBe('exiting')
    expect(store.getState().selection).toEqual([a, b])
  })

  it('removes already-closed nodes before a later close is cancelled', async () => {
    const store = createCanvasStore()
    const a = store.getState().addNode('term-a', 'terminal', { x: 0, y: 0 }, { width: 100, height: 80 })
    const b = store.getState().addNode('term-b', 'terminal', { x: 200, y: 0 }, { width: 100, height: 80 })
    closePanelWithConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    store.getState().selectNodes([a, b])
    await store.getState().deleteSelection()

    expect(store.getState().nodes[a].animationState).toBe('exiting')
    expect(store.getState().nodes[b].animationState).not.toBe('exiting')
    expect(store.getState().selection).toEqual([b])
  })

  it('does nothing when the selection is empty', async () => {
    const store = createCanvasStore()
    store.getState().addNode('term-a', 'terminal', { x: 0, y: 0 }, { width: 100, height: 80 })

    await store.getState().deleteSelection()

    expect(closePanelWithConfirm).not.toHaveBeenCalled()
  })
})
