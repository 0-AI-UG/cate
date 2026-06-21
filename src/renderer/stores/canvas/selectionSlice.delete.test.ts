// =============================================================================
// Regression: bulk delete (Delete key / "Close All" on a multi-node selection)
// must route panel-backed nodes through the real closePanel flow — the SOLE
// place PTY/agent disposal and panel-record removal happen. Previously it called
// only removeNode per node, leaving terminals/agents running invisibly and
// zombie records in workspace.panels/session.json.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'

const closePanel = vi.fn()
const SELECTED_WS = 'ws-1'

vi.mock('../appStore', () => ({
  useAppStore: {
    getState: () => ({ selectedWorkspaceId: SELECTED_WS, closePanel }),
  },
}))

import { createCanvasStore } from '../canvasStore'
import type { DockLayoutNode } from '../../../shared/types'

function tabs(panelIds: string[]): DockLayoutNode {
  return { type: 'tabs', id: `stack-${panelIds.join('-')}`, panelIds, activeIndex: 0 }
}

// deleteSelection closes panels via a dynamically-imported appStore (the import
// resolves asynchronously), so let the import + close callback settle before asserting.
async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

describe('deleteSelection routes panel-backed nodes through closePanel', () => {
  beforeEach(() => {
    closePanel.mockReset()
  })

  it('closes the panel for every selected single-panel node (with the selected workspace id)', async () => {
    const store = createCanvasStore()
    const a = store.getState().addNode('term-a', 'terminal', { x: 0, y: 0 }, { width: 100, height: 80 })
    const b = store.getState().addNode('term-b', 'terminal', { x: 200, y: 0 }, { width: 100, height: 80 })

    store.getState().selectNodes([a, b])
    store.getState().deleteSelection()
    await flushMicrotasks()

    expect(closePanel).toHaveBeenCalledWith(SELECTED_WS, 'term-a')
    expect(closePanel).toHaveBeenCalledWith(SELECTED_WS, 'term-b')
    expect(closePanel).toHaveBeenCalledTimes(2)

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
    store.getState().deleteSelection()
    await flushMicrotasks()

    expect(closePanel).toHaveBeenCalledWith(SELECTED_WS, 'p1')
    expect(closePanel).toHaveBeenCalledWith(SELECTED_WS, 'p2')
    expect(closePanel).toHaveBeenCalledWith(SELECTED_WS, 'p3')
    expect(closePanel).toHaveBeenCalledTimes(3)
  })

  it('does nothing when the selection is empty', async () => {
    const store = createCanvasStore()
    store.getState().addNode('term-a', 'terminal', { x: 0, y: 0 }, { width: 100, height: 80 })

    store.getState().deleteSelection()
    await flushMicrotasks()

    expect(closePanel).not.toHaveBeenCalled()
  })
})
