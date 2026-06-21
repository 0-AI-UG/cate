// =============================================================================
// Canvas store — end-to-end lifecycle tests across the composed slices: node
// CRUD + focus/z-order, viewport math (zoom clamping, anchor-preserving zoom,
// fit/selection zoom), undo/redo through a bulk delete, spatial keyboard
// navigation, selection arrangement (stack/tidy/auto-layout), and the
// loadWorkspaceCanvas session round-trip. These intentionally drive several
// slices in one scenario — the bugs this guards against live at the seams.
// =============================================================================

import { describe, it, expect, vi } from 'vitest'

// deleteSelection routes panel closure through a lazily-imported appStore.
const closePanel = vi.fn()
vi.mock('./appStore', () => ({
  useAppStore: {
    getState: () => ({ selectedWorkspaceId: 'ws-1', closePanel }),
  },
}))

import { createCanvasStore } from './canvasStore'
import { focusedNodeId } from './canvas/selectionModel'
import { ZOOM_MIN, ZOOM_MAX } from '../../shared/types'
import type { CanvasNodeState } from '../../shared/types'

const SIZE = { width: 200, height: 200 }

// Positions are grid-multiples (CANVAS_GRID_SIZE = 20) and far apart, so
// findFreePosition returns them verbatim instead of nudging.
function addThree(store: ReturnType<typeof createCanvasStore>) {
  const a = store.getState().addNode('panel-a', 'terminal', { x: 0, y: 0 }, SIZE)
  const b = store.getState().addNode('panel-b', 'editor', { x: 1000, y: 0 }, SIZE)
  const c = store.getState().addNode('panel-c', 'terminal', { x: 2000, y: 0 }, SIZE)
  return { a, b, c }
}

function nodesOverlap(a: CanvasNodeState, b: CanvasNodeState): boolean {
  return (
    a.origin.x < b.origin.x + b.size.width &&
    b.origin.x < a.origin.x + a.size.width &&
    a.origin.y < b.origin.y + b.size.height &&
    b.origin.y < a.origin.y + a.size.height
  )
}

async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('node lifecycle', () => {
  it('creates nodes at the requested origins with monotonic creation/z counters', () => {
    const store = createCanvasStore()
    const { a, b, c } = addThree(store)

    const nodes = store.getState().nodes
    expect(nodes[a].origin).toEqual({ x: 0, y: 0 })
    expect(nodes[b].origin).toEqual({ x: 1000, y: 0 })
    expect(nodes[c].origin).toEqual({ x: 2000, y: 0 })
    expect([nodes[a], nodes[b], nodes[c]].map((n) => n.creationIndex)).toEqual([0, 1, 2])
    expect(nodes[b].zOrder).toBeGreaterThan(nodes[a].zOrder)
    expect(nodes[c].zOrder).toBeGreaterThan(nodes[b].zOrder)
    // Each node is seeded with a single-tab mini-dock for its panel.
    expect(nodes[a].dockLayout).toMatchObject({ type: 'tabs', panelIds: ['panel-a'], activeIndex: 0 })
  })

  it('refuses canvas-on-canvas at the data layer', () => {
    const store = createCanvasStore()
    const id = store.getState().addNode('nested-canvas', 'canvas', { x: 0, y: 0 }, SIZE)
    expect(id).toBe('')
    expect(Object.keys(store.getState().nodes)).toHaveLength(0)
  })

  it('focusNode raises the node, bumps focusEpoch, and ends keyboard-nav mode', () => {
    const store = createCanvasStore()
    const { a, b } = addThree(store)
    store.getState().panViewport('down') // sets suppressAutoFocus
    expect(store.getState().suppressAutoFocus).toBe(true)
    const epochBefore = store.getState().focusEpoch
    const topBefore = store.getState().nodes[b].zOrder

    store.getState().focusNode(a)

    const s = store.getState()
    expect(focusedNodeId(s)).toBe(a)
    expect(s.focusEpoch).toBe(epochBefore + 1)
    expect(s.nodes[a].zOrder).toBeGreaterThan(topBefore)
    expect(s.suppressAutoFocus).toBe(false)

    // Re-focusing the same node still bumps the epoch (panels re-run side effects).
    store.getState().focusNode(a)
    expect(store.getState().focusEpoch).toBe(epochBefore + 2)
  })

  it('removeNode marks exiting + drops focus; finalizeRemoveNode deletes', () => {
    const store = createCanvasStore()
    const { a } = addThree(store)
    store.getState().focusNode(a)

    store.getState().removeNode(a)
    expect(store.getState().nodes[a].animationState).toBe('exiting')
    expect(focusedNodeId(store.getState())).toBeNull()

    store.getState().finalizeRemoveNode(a)
    expect(store.getState().nodes[a]).toBeUndefined()
  })

  it('moveToBack places a node strictly below the current minimum', () => {
    const store = createCanvasStore()
    const { a, b, c } = addThree(store)

    store.getState().moveToBack(c)

    const nodes = store.getState().nodes
    expect(nodes[c].zOrder).toBeLessThan(nodes[a].zOrder)
    expect(nodes[c].zOrder).toBeLessThan(nodes[b].zOrder)

    store.getState().moveToFront(c)
    expect(nodes[a].zOrder).toBeLessThan(store.getState().nodes[c].zOrder)
  })

  it('cycles nextNode/previousNode in creation order with wrap-around', () => {
    const store = createCanvasStore()
    const { a, b, c } = addThree(store)

    expect(store.getState().nextNode()).toBe(a) // nothing focused → first
    store.getState().focusNode(a)
    expect(store.getState().nextNode()).toBe(b)
    store.getState().focusNode(c)
    expect(store.getState().nextNode()).toBe(a) // wraps
    expect(store.getState().previousNode()).toBe(b)
    store.getState().focusNode(a)
    expect(store.getState().previousNode()).toBe(c) // wraps backwards
  })
})

describe('viewport math', () => {
  it('canvasToView/viewToCanvas are exact inverses under the live zoom/offset', () => {
    const store = createCanvasStore()
    store.getState().setZoomAndOffset(2, { x: 100, y: 50 })

    expect(store.getState().canvasToView({ x: 10, y: 10 })).toEqual({ x: 120, y: 70 })
    const roundTrip = store.getState().viewToCanvas(store.getState().canvasToView({ x: 37, y: -12 }))
    expect(roundTrip.x).toBeCloseTo(37)
    expect(roundTrip.y).toBeCloseTo(-12)
  })

  it('clamps zoom everywhere it can be set', () => {
    const store = createCanvasStore()
    store.getState().setZoom(100)
    expect(store.getState().zoomLevel).toBe(ZOOM_MAX)
    store.getState().setZoom(0.0001)
    expect(store.getState().zoomLevel).toBe(ZOOM_MIN)
    store.getState().setZoomAndOffset(50, { x: 0, y: 0 })
    expect(store.getState().zoomLevel).toBe(ZOOM_MAX)
    store.getState().setContainerSize({ width: 1200, height: 800 })
    store.getState().zoomAroundCenter(0.0001)
    expect(store.getState().zoomLevel).toBe(ZOOM_MIN)
  })

  it('zoomAroundCenter keeps the canvas point under the view center fixed', () => {
    const store = createCanvasStore()
    store.getState().setContainerSize({ width: 1200, height: 800 })
    store.getState().setZoomAndOffset(0.8, { x: -340, y: 220 })
    const anchorBefore = store.getState().viewToCanvas({ x: 600, y: 400 })

    store.getState().zoomAroundCenter(2)

    expect(store.getState().zoomLevel).toBe(2)
    const anchorAfter = store.getState().viewToCanvas({ x: 600, y: 400 })
    expect(anchorAfter.x).toBeCloseTo(anchorBefore.x)
    expect(anchorAfter.y).toBeCloseTo(anchorBefore.y)
  })

  it('viewFrame reports the node rect scaled into view space', () => {
    const store = createCanvasStore()
    const id = store.getState().addNode('p', 'editor', { x: 100, y: 40 }, { width: 300, height: 200 })
    store.getState().setZoomAndOffset(2, { x: 10, y: 20 })

    expect(store.getState().viewFrame(id)).toEqual({
      origin: { x: 210, y: 100 },
      size: { width: 600, height: 400 },
    })
    expect(store.getState().viewFrame('missing')).toBeNull()
  })

  it('zoomToFit brings every node fully on screen', () => {
    const store = createCanvasStore()
    store.getState().addNode('p1', 'editor', { x: 0, y: 0 }, { width: 400, height: 300 })
    store.getState().addNode('p2', 'editor', { x: 1000, y: 800 }, { width: 400, height: 300 })
    store.getState().setContainerSize({ width: 1200, height: 800 })

    store.getState().zoomToFit()

    const topLeft = store.getState().canvasToView({ x: 0, y: 0 })
    const bottomRight = store.getState().canvasToView({ x: 1400, y: 1100 })
    expect(topLeft.x).toBeGreaterThanOrEqual(0)
    expect(topLeft.y).toBeGreaterThanOrEqual(0)
    expect(bottomRight.x).toBeLessThanOrEqual(1200)
    expect(bottomRight.y).toBeLessThanOrEqual(800)
  })

  it('zoomToSelection caps a single-node target at 1.5x', () => {
    const store = createCanvasStore()
    const id = store.getState().addNode('p1', 'editor', { x: 0, y: 0 }, { width: 200, height: 100 })
    store.getState().setContainerSize({ width: 1200, height: 800 })
    store.getState().selectNodes([id])

    store.getState().zoomToSelection()

    expect(store.getState().zoomLevel).toBe(1.5)
  })

  it('toggleMaximize fills the visible canvas and restores exactly on toggle back', () => {
    const store = createCanvasStore()
    const id = store.getState().addNode('p', 'editor', { x: 100, y: 100 }, { width: 300, height: 200 })
    store.getState().setContainerSize({ width: 1200, height: 800 })
    store.getState().setZoomAndOffset(1, { x: 0, y: 0 })

    store.getState().toggleMaximize(id, { width: 1200, height: 800 })
    const maxed = store.getState().nodes[id]
    expect(maxed.origin).toEqual({ x: 20, y: 20 })
    expect(maxed.size).toEqual({ width: 1160, height: 760 })
    expect(maxed.preMaximizeOrigin).toEqual({ x: 100, y: 100 })
    expect(focusedNodeId(store.getState())).toBe(id)

    store.getState().toggleMaximize(id, { width: 1200, height: 800 })
    const restored = store.getState().nodes[id]
    expect(restored.origin).toEqual({ x: 100, y: 100 })
    expect(restored.size).toEqual({ width: 300, height: 200 })
    expect(restored.preMaximizeOrigin).toBeUndefined()
    expect(restored.preMaximizeSize).toBeUndefined()
  })
})

describe('undo/redo across a bulk delete', () => {
  it('undo restores deleted nodes + selection; redo reapplies the delete', async () => {
    const store = createCanvasStore()
    const { a, b } = addThree(store)
    store.getState().selectNodes([a, b])

    store.getState().deleteSelection()
    await flushMicrotasks()
    expect(closePanel).toHaveBeenCalledWith('ws-1', 'panel-a')
    expect(closePanel).toHaveBeenCalledWith('ws-1', 'panel-b')
    expect(store.getState().nodes[a].animationState).toBe('exiting')
    expect(store.getState().nodes[b].animationState).toBe('exiting')
    expect(store.getState().selection.length).toBe(0)

    // deleteSelection pushes once + once per removeNode → two undos rewind it.
    store.getState().undo()
    store.getState().undo()
    expect(store.getState().nodes[a].animationState).not.toBe('exiting')
    expect(store.getState().nodes[b].animationState).not.toBe('exiting')
    expect([...store.getState().selection].sort()).toEqual([a, b].sort())

    store.getState().redo()
    store.getState().redo()
    expect(store.getState().nodes[a].animationState).toBe('exiting')
    expect(store.getState().nodes[b].animationState).toBe('exiting')
    expect(store.getState().selection.length).toBe(0)
  })

  it('a new mutation clears the redo stack', () => {
    const store = createCanvasStore()
    const { a } = addThree(store)
    store.getState().removeNode(a)
    store.getState().undo()
    expect(store.getState().future.length).toBeGreaterThan(0)

    store.getState().addNode('panel-d', 'terminal', { x: 3000, y: 0 }, SIZE)

    expect(store.getState().future).toHaveLength(0)
    store.getState().redo() // no-op
    expect(store.getState().nodes[a]).toBeDefined()
  })

  it('selection restored by undo never references nodes absent from that snapshot', () => {
    const store = createCanvasStore()
    const { a } = addThree(store)
    // History entry captured BEFORE d exists, while d is selected later.
    const d = store.getState().addNode('panel-d', 'terminal', { x: 3000, y: 0 }, SIZE)
    store.getState().selectNodes([a, d])
    store.getState().removeNode(a)

    store.getState().undo() // restores pre-remove snapshot
    store.getState().undo() // restores pre-add-d snapshot (selection had nothing yet)

    const s = store.getState()
    for (const id of s.selection) {
      expect(s.nodes[id], `selected id ${id} must exist`).toBeDefined()
    }
    expect(s.nodes[d]).toBeUndefined()
  })
})

describe('spatial keyboard navigation', () => {
  function setupRow(store: ReturnType<typeof createCanvasStore>) {
    const ids = addThree(store) // x = 0 / 1000 / 2000, all 200x200 at y=0
    store.getState().setContainerSize({ width: 1200, height: 800 })
    store.getState().setZoomAndOffset(1, { x: 0, y: 0 })
    return ids
  }

  it('navigateDirection focuses the nearest node in the cone and centers it', () => {
    const store = createCanvasStore()
    const { a, b, c } = setupRow(store)
    store.getState().focusNode(a)

    store.getState().navigateDirection('right')
    expect(focusedNodeId(store.getState())).toBe(b)
    // focusAndCenter: node center (1100, 100) maps to the container center.
    expect(store.getState().viewportOffset).toEqual({ x: 600 - 1100, y: 400 - 100 })

    store.getState().navigateDirection('right')
    expect(focusedNodeId(store.getState())).toBe(c)
    store.getState().navigateDirection('left')
    expect(focusedNodeId(store.getState())).toBe(b)
  })

  it('ignores candidates outside the directional cone', () => {
    const store = createCanvasStore()
    const a = store.getState().addNode('panel-a', 'terminal', { x: 0, y: 0 }, SIZE)
    // Mostly below-right: |dy| > |dx| from a's center, so not "right" of it.
    store.getState().addNode('panel-d', 'terminal', { x: 400, y: 1200 }, SIZE)
    store.getState().setContainerSize({ width: 1200, height: 800 })
    store.getState().focusNode(a)

    store.getState().navigateDirection('right')

    expect(focusedNodeId(store.getState())).toBe(a)
  })

  it('navigateSelect moves the selection cursor without grabbing focus', () => {
    const store = createCanvasStore()
    const { a, b } = setupRow(store)
    store.getState().focusNode(a)

    store.getState().navigateSelect('right')

    const s = store.getState()
    expect([...s.selection]).toEqual([b])
    expect(focusedNodeId(s)).toBeNull()
    expect(s.suppressAutoFocus).toBe(true)
    // No rAF in this environment → the viewport tween applies instantly.
    expect(s.viewportOffset).toEqual({ x: 600 - 1100, y: 400 - 100 })
  })

  it('panViewport steps the camera and a manual pan re-enables auto-focus', () => {
    const store = createCanvasStore()
    store.getState().setContainerSize({ width: 1200, height: 800 })

    store.getState().panViewport('down')
    expect(store.getState().viewportOffset).toEqual({ x: 0, y: -120 })
    expect(store.getState().suppressAutoFocus).toBe(true)

    store.getState().panViewport('right')
    expect(store.getState().viewportOffset).toEqual({ x: -120, y: -120 })

    store.getState().setViewportOffset({ x: 5, y: 5 })
    expect(store.getState().suppressAutoFocus).toBe(false)
  })
})

describe('selection arrangement', () => {
  it('stackSelected(row) lines nodes up left-to-right with the gap, anchored at the selection origin', () => {
    const store = createCanvasStore()
    const n1 = store.getState().addNode('p1', 'editor', { x: 0, y: 0 }, { width: 200, height: 100 })
    const n2 = store.getState().addNode('p2', 'editor', { x: 500, y: 40 }, { width: 300, height: 100 })
    const n3 = store.getState().addNode('p3', 'editor', { x: 1000, y: 80 }, { width: 250, height: 100 })
    store.getState().selectNodes([n1, n2, n3])

    store.getState().stackSelected('row', 16)

    const nodes = store.getState().nodes
    expect(nodes[n1].origin).toEqual({ x: 0, y: 0 })
    expect(nodes[n2].origin).toEqual({ x: 216, y: 0 })
    expect(nodes[n3].origin).toEqual({ x: 532, y: 0 })
  })

  it('tidyGridSelected packs mixed-size nodes into a non-overlapping grid', () => {
    const store = createCanvasStore()
    const ids = [
      store.getState().addNode('p1', 'editor', { x: 0, y: 0 }, { width: 200, height: 100 }),
      store.getState().addNode('p2', 'editor', { x: 600, y: 0 }, { width: 300, height: 150 }),
      store.getState().addNode('p3', 'editor', { x: 0, y: 600 }, { width: 250, height: 120 }),
      store.getState().addNode('p4', 'editor', { x: 600, y: 600 }, { width: 180, height: 90 }),
    ]
    store.getState().selectNodes(ids)

    store.getState().tidyGridSelected(16)

    const list = ids.map((id) => store.getState().nodes[id])
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        expect(nodesOverlap(list[i], list[j]), `nodes ${i} and ${j} overlap`).toBe(false)
      }
    }
    // 2-column grid anchored at the selection's top-left, cells = max w/h.
    expect(store.getState().nodes[ids[0]].origin).toEqual({ x: 0, y: 0 })
    expect(store.getState().nodes[ids[1]].origin).toEqual({ x: 316, y: 0 })
  })

  it('autoLayout produces a non-overlapping grid for the whole canvas', () => {
    const store = createCanvasStore()
    for (let i = 0; i < 5; i++) {
      store.getState().addNode(`p${i}`, 'editor', { x: i * 40, y: i * 40 }, { width: 600, height: 400 })
    }
    store.getState().setContainerSize({ width: 1600, height: 1000 })

    store.getState().autoLayout()

    const list = Object.values(store.getState().nodes)
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        expect(nodesOverlap(list[i], list[j]), `nodes ${i} and ${j} overlap`).toBe(false)
      }
    }
    // autoLayout is undoable.
    store.getState().undo()
    expect(store.getState().nodes[list[0].id]).toBeDefined()
  })
})

describe('degenerate inputs and limits', () => {
  it('mutations on unknown node ids are no-ops and do not pollute history or focus', () => {
    const store = createCanvasStore()
    store.getState().addNode('panel-a', 'terminal', { x: 0, y: 0 }, SIZE)
    const nodesBefore = store.getState().nodes
    const historyLen = store.getState().history.length
    const epochBefore = store.getState().focusEpoch

    store.getState().moveNode('ghost', { x: 9, y: 9 })
    store.getState().resizeNode('ghost', { width: 9, height: 9 })
    store.getState().focusNode('ghost')
    store.getState().removeNode('ghost')
    store.getState().togglePin('ghost')
    store.getState().moveToFront('ghost')
    store.getState().setNodeAnimationState('ghost', 'idle')
    store.getState().toggleMaximize('ghost', { width: 100, height: 100 })

    expect(store.getState().nodes).toEqual(nodesBefore)
    expect(store.getState().history).toHaveLength(historyLen)
    expect(focusedNodeId(store.getState())).toBeNull()
    expect(store.getState().focusEpoch).toBe(epochBefore)
  })

  it('undo/redo on empty stacks are no-ops', () => {
    const store = createCanvasStore()
    const { a } = addThree(store)

    store.getState().redo() // future empty
    expect(store.getState().nodes[a]).toBeDefined()

    // Drain history past the bottom — extra undos must not throw or corrupt.
    for (let i = 0; i < 10; i++) store.getState().undo()
    expect(Object.keys(store.getState().nodes)).toHaveLength(0) // back to empty canvas
    expect(store.getState().history).toHaveLength(0)
  })

  it('zoomToFit / zoomToSelection without nodes or a measured container are no-ops', () => {
    const store = createCanvasStore()
    store.getState().setContainerSize({ width: 1200, height: 800 })
    store.getState().zoomToFit() // no nodes
    store.getState().zoomToSelection() // no nodes, no selection
    expect(store.getState().zoomLevel).toBe(1)
    expect(store.getState().viewportOffset).toEqual({ x: 0, y: 0 })

    const unmeasured = createCanvasStore() // containerSize still 0x0
    unmeasured.getState().addNode('p', 'editor', { x: 0, y: 0 }, SIZE)
    unmeasured.getState().zoomToFit()
    expect(unmeasured.getState().zoomLevel).toBe(1)
  })

  it('caps undo history at 100 entries', () => {
    const store = createCanvasStore()
    store.getState().addNode('panel-a', 'terminal', { x: 0, y: 0 }, SIZE)

    for (let i = 0; i < 150; i++) store.getState().pushHistory()

    expect(store.getState().history).toHaveLength(100)
    for (let i = 0; i < 110; i++) store.getState().undo() // drains without error
    expect(store.getState().history).toHaveLength(0)
  })

  it('nextNode/previousNode fall back to the ends when the focused id is stale', () => {
    const store = createCanvasStore()
    const { a, b, c } = addThree(store)
    store.getState().focusNode(a)
    // finalizeRemoveNode without removeNode leaves focusedNodeId dangling — the
    // queries must still answer from the live node set.
    store.getState().finalizeRemoveNode(a)

    expect(store.getState().nextNode()).toBe(b)
    expect(store.getState().previousNode()).toBe(c)
  })
})

describe('loadWorkspaceCanvas session round-trip', () => {
  it('restores geometry exactly through JSON serialization, resets transients, clamps zoom', () => {
    const source = createCanvasStore()
    const { a, b, c } = addThree(source)
    source.getState().moveNode(b, { x: 1500, y: 300 })
    source.getState().resizeNode(c, { width: 640, height: 480 })
    source.getState().focusNode(a)
    source.getState().selectNodes([a, b])
    source.getState().setNodeDockLayout(a, {
      type: 'tabs',
      id: 'stack-1',
      panelIds: ['panel-a', 'panel-extra'],
      activeIndex: 1,
    })

    // What sessionSave persists: the nodes record + viewport, through JSON.
    const persisted = JSON.parse(
      JSON.stringify({
        nodes: source.getState().nodes,
        viewportOffset: { x: -250, y: 80 },
        zoomLevel: 99, // corrupt/out-of-range value on disk
      }),
    )

    const restored = createCanvasStore()
    restored.getState().loadWorkspaceCanvas(persisted.nodes, persisted.viewportOffset, persisted.zoomLevel)

    const s = restored.getState()
    expect(s.zoomLevel).toBe(ZOOM_MAX)
    expect(s.viewportOffset).toEqual({ x: -250, y: 80 })
    // Geometry and per-node dock layout survive byte-for-byte.
    expect(s.nodes[b].origin).toEqual({ x: 1500, y: 300 })
    expect(s.nodes[c].size).toEqual({ width: 640, height: 480 })
    expect(s.nodes[a].dockLayout).toEqual({
      type: 'tabs',
      id: 'stack-1',
      panelIds: ['panel-a', 'panel-extra'],
      activeIndex: 1,
    })
    // Transients reset: no focus/selection/history, nothing animates on restore.
    expect(focusedNodeId(s)).toBeNull()
    expect(s.selection.length).toBe(0)
    expect(s.history).toHaveLength(0)
    expect(Object.values(s.nodes).every((n) => n.animationState === 'idle')).toBe(true)
    // Counters resume past the loaded maxima — new nodes stack on top.
    const d = restored.getState().addNode('panel-d', 'terminal', { x: 4000, y: 0 }, SIZE)
    const maxLoadedZ = Math.max(...[a, b, c].map((id) => s.nodes[id].zOrder))
    expect(restored.getState().nodes[d].zOrder).toBeGreaterThan(maxLoadedZ)
    expect(restored.getState().nodes[d].creationIndex).toBe(3)
  })
})
