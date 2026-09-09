// =============================================================================
// Regression: bulk delete (Delete key / "Close All" on a multi-node selection)
// must use closePanelsWithConfirm for every panel, matching normal panel closes
// (including dirty-editor, running-terminal, and canvas confirmation flows).
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'

const closePanelsWithConfirm = vi.fn()
const SELECTED_WS = 'ws-1'

// Live panel-record map so the history transaction can snapshot records and
// undo can re-add them. Seeded per test with the panel ids the test uses.
const wsPanels: Record<string, { id: string; type: string; title: string; isDirty: boolean }> = {}
const addPanel = vi.fn((_wsId: string, panel: { id: string }) => {
  wsPanels[panel.id] = panel as (typeof wsPanels)[string]
})
const closePanel = vi.fn((_wsId: string, panelId: string) => {
  delete wsPanels[panelId]
})

vi.mock('../appStore', () => ({
  useAppStore: {
    getState: () => ({
      selectedWorkspaceId: SELECTED_WS,
      workspaces: [{ id: SELECTED_WS, panels: wsPanels }],
      addPanel,
      closePanel,
    }),
  },
}))

vi.mock('../../lib/closePanelWithConfirm', () => ({ closePanelsWithConfirm }))
vi.mock('../../lib/editor/editorDocuments', () => ({ captureEditorPanel: (panel: unknown) => panel }))

import { createCanvasStore } from '../canvasStore'
import type { DockLayoutNode } from '../../../shared/types'

function tabs(panelIds: string[]): DockLayoutNode {
  return { type: 'tabs', id: `stack-${panelIds.join('-')}`, panelIds, activeIndex: 0 }
}

function seedPanels(ids: string[]) {
  for (const id of Object.keys(wsPanels)) delete wsPanels[id]
  for (const id of ids) wsPanels[id] = { id, type: 'terminal', title: id, isDirty: false }
}

describe('deleteSelection routes panel-backed nodes through closePanelsWithConfirm', () => {
  beforeEach(() => {
    closePanelsWithConfirm.mockReset()
    // The real closePanelsWithConfirm removes the panel record on success.
    closePanelsWithConfirm.mockImplementation(async (_wsId: string, panelIds: string[], remove: (id: string) => void) => {
      panelIds.forEach(remove)
      return true
    })
    addPanel.mockClear()
    closePanel.mockClear()
    seedPanels(['term-a', 'term-b', 'p1', 'p2', 'p3'])
  })

  it('closes every selected single-panel node through the normal close path', async () => {
    const store = createCanvasStore()
    const a = store.getState().addNode('term-a', 'terminal', { x: 0, y: 0 }, { width: 100, height: 80 })
    const b = store.getState().addNode('term-b', 'terminal', { x: 200, y: 0 }, { width: 100, height: 80 })

    store.getState().selectNodes([a, b])
    await store.getState().deleteSelection()

    expect(closePanelsWithConfirm).toHaveBeenCalledExactlyOnceWith(SELECTED_WS, ['term-a', 'term-b'], expect.any(Function))

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

    expect(closePanelsWithConfirm).toHaveBeenCalledExactlyOnceWith(SELECTED_WS, ['p1', 'p2', 'p3'], expect.any(Function))
  })

  it('keeps the selection intact when a normal close is cancelled', async () => {
    const store = createCanvasStore()
    const a = store.getState().addNode('term-a', 'terminal', { x: 0, y: 0 }, { width: 100, height: 80 })
    const b = store.getState().addNode('term-b', 'terminal', { x: 200, y: 0 }, { width: 100, height: 80 })
    closePanelsWithConfirm.mockResolvedValueOnce(false)

    store.getState().selectNodes([a, b])
    await store.getState().deleteSelection()

    expect(closePanelsWithConfirm).toHaveBeenCalledTimes(1)
    expect(store.getState().nodes[a].animationState).not.toBe('exiting')
    expect(store.getState().nodes[b].animationState).not.toBe('exiting')
    expect(store.getState().selection).toEqual([a, b])
  })

  it('does nothing when the selection is empty', async () => {
    const store = createCanvasStore()
    store.getState().addNode('term-a', 'terminal', { x: 0, y: 0 }, { width: 100, height: 80 })

    await store.getState().deleteSelection()

    expect(closePanelsWithConfirm).not.toHaveBeenCalled()
  })
})
