// =============================================================================
// Regression tests for canvasStore.addNode dedup-by-panelId invariant.
//
// Bug: addNode does not dedupe by panelId. Multiple add-without-cleanup paths
// (e.g. dragging a panel out and back in before the prior canvas node is torn
// down) can produce two CanvasNodeState entries that both reference the same
// panelId. Deleting one removes the underlying panel and makes the other
// duplicate "disappear" too.
//
// Invariant we want: ONE canvas node per panelId per canvas store, at any time.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { createCanvasStore, placementCluster, placementSizeVariants } from './canvasStore'
import { CANVAS_GRID_SIZE } from '../canvas/layoutEngine'
import type { CanvasNodeState, CanvasNodeId } from '../../shared/types'

describe('canvasStore.addNode panelId dedup invariant', () => {
  it('single addNode produces exactly one node for that panelId', () => {
    const store = createCanvasStore()
    store.getState().addNode('panel-X', 'editor', { x: 0, y: 0 }, { width: 100, height: 80 })

    const nodes = Object.values(store.getState().nodes)
    const matching = nodes.filter((n) => n.panelId === 'panel-X')
    expect(matching).toHaveLength(1)
  })

  it('repeated addNode for the same panelId produces exactly ONE node', () => {
    const store = createCanvasStore()
    store.getState().addNode('panel-X', 'editor', { x: 0, y: 0 }, { width: 100, height: 80 })
    store.getState().addNode('panel-X', 'editor', { x: 200, y: 200 }, { width: 100, height: 80 })

    const nodes = Object.values(store.getState().nodes)
    const matching = nodes.filter((n) => n.panelId === 'panel-X')
    // Today this produces 2; post-fix it should be 1.
    expect(matching).toHaveLength(1)
  })

  it('repeated addNode for the same panelId repositions the existing node', () => {
    const store = createCanvasStore()
    const firstId = store.getState().addNode(
      'panel-X',
      'editor',
      { x: 0, y: 0 },
      { width: 100, height: 80 },
    )
    store.getState().addNode('panel-X', 'editor', { x: 200, y: 200 }, { width: 100, height: 80 })

    // nodeForPanel must still resolve to the original node id (no new node minted).
    expect(store.getState().nodeForPanel('panel-X')).toBe(firstId)

    // And that single node's origin should reflect the second-call coords.
    const node = store.getState().nodes[firstId]
    expect(node).toBeDefined()
    expect(node!.origin).toEqual({ x: 200, y: 200 })
  })

  it('different panelIds remain independent', () => {
    const store = createCanvasStore()
    const idA = store.getState().addNode('panel-A', 'editor', { x: 0, y: 0 }, { width: 100, height: 80 })
    const idB = store.getState().addNode('panel-B', 'editor', { x: 300, y: 300 }, { width: 100, height: 80 })

    expect(idA).not.toBe(idB)
    const nodes = Object.values(store.getState().nodes)
    expect(nodes).toHaveLength(2)
    expect(nodes.some((n) => n.panelId === 'panel-A')).toBe(true)
    expect(nodes.some((n) => n.panelId === 'panel-B')).toBe(true)
  })
})

// Regression: a canvas tab dragged onto a canvas viewport (or any other path
// that reached addNode with panelType==='canvas') used to create a nested
// canvas — broken interaction (ambiguous drag targets, duplicate stores keyed
// by the same id, nested zoom). Block at the data layer.
describe('canvasStore.addNode — canvas-on-canvas is rejected', () => {
  it('returns empty string and does not add the node', () => {
    const store = createCanvasStore()
    const result = store.getState().addNode('panel-canvas-1', 'canvas', { x: 10, y: 10 }, { width: 400, height: 300 })
    expect(result).toBe('')
    expect(Object.keys(store.getState().nodes)).toHaveLength(0)
  })
})

// focusEpoch is the signal panels watch to re-fire focus side effects when the
// same node is re-focused (e.g. minimap click on the already-focused node).
// Without it, useEffect deps on `isFocused` alone would not re-run.
describe('canvasStore — focusEpoch bumps on focus actions', () => {
  it('starts at 0', () => {
    const store = createCanvasStore()
    expect(store.getState().focusEpoch).toBe(0)
  })

  it('focusNode increments focusEpoch each call, even for the already-focused node', () => {
    const store = createCanvasStore()
    const id = store.getState().addNode('p1', 'terminal', { x: 0, y: 0 }, { width: 100, height: 80 })

    const before = store.getState().focusEpoch
    store.getState().focusNode(id)
    const afterFirst = store.getState().focusEpoch
    store.getState().focusNode(id)
    const afterSecond = store.getState().focusEpoch

    expect(afterFirst).toBe(before + 1)
    expect(afterSecond).toBe(before + 2)
    expect(store.getState().focusedNodeId).toBe(id)
  })

  it('focusAndCenter increments focusEpoch', () => {
    const store = createCanvasStore()
    const id = store.getState().addNode('p1', 'terminal', { x: 0, y: 0 }, { width: 100, height: 80 })
    store.getState().setContainerSize({ width: 800, height: 600 })

    const before = store.getState().focusEpoch
    store.getState().focusAndCenter(id)
    expect(store.getState().focusEpoch).toBe(before + 1)
    expect(store.getState().focusedNodeId).toBe(id)
  })

  it('focusAndCenter bumps focusEpoch even when called twice on the same node', () => {
    const store = createCanvasStore()
    const id = store.getState().addNode('p1', 'terminal', { x: 0, y: 0 }, { width: 100, height: 80 })
    store.getState().setContainerSize({ width: 800, height: 600 })

    store.getState().focusAndCenter(id)
    const after1 = store.getState().focusEpoch
    store.getState().focusAndCenter(id)
    const after2 = store.getState().focusEpoch

    expect(after2).toBe(after1 + 1)
  })

  it('focusNode on a missing nodeId does not bump focusEpoch', () => {
    const store = createCanvasStore()
    const before = store.getState().focusEpoch
    store.getState().focusNode('does-not-exist')
    expect(store.getState().focusEpoch).toBe(before)
  })

  it('toggleMaximize bumps focusEpoch', () => {
    const store = createCanvasStore()
    const id = store.getState().addNode('p1', 'terminal', { x: 0, y: 0 }, { width: 100, height: 80 })
    store.getState().setContainerSize({ width: 800, height: 600 })

    const before = store.getState().focusEpoch
    store.getState().toggleMaximize(id, { width: 800, height: 600 })
    expect(store.getState().focusEpoch).toBe(before + 1)
  })
})

// =============================================================================
// navigateDirection — arrow-key spatial navigation between nodes.
// =============================================================================

describe('canvasStore.navigateDirection', () => {
  function setup() {
    const store = createCanvasStore()
    store.getState().setContainerSize({ width: 1000, height: 800 })
    // Five nodes around a center node, each ~500px away on one axis.
    const c = store.getState().addNode('c', 'editor', { x: -50, y: -40 }, { width: 100, height: 80 })
    const r = store.getState().addNode('r', 'editor', { x: 450, y: -40 }, { width: 100, height: 80 })
    const l = store.getState().addNode('l', 'editor', { x: -550, y: -40 }, { width: 100, height: 80 })
    const u = store.getState().addNode('u', 'editor', { x: -50, y: -540 }, { width: 100, height: 80 })
    const d = store.getState().addNode('d', 'editor', { x: -50, y: 460 }, { width: 100, height: 80 })
    return { store, c, r, l, u, d }
  }

  it('moves focus to the nearest node in each direction', () => {
    const { store, c, r, l, u, d } = setup()
    const nav = (dir: 'up' | 'down' | 'left' | 'right') => {
      store.getState().focusNode(c)
      store.getState().navigateDirection(dir)
      return store.getState().focusedNodeId
    }
    expect(nav('right')).toBe(r)
    expect(nav('left')).toBe(l)
    expect(nav('up')).toBe(u)
    expect(nav('down')).toBe(d)
  })

  it('is a no-op when no node lies in the requested direction', () => {
    const { store, r } = setup()
    store.getState().focusNode(r) // rightmost node
    store.getState().navigateDirection('right')
    expect(store.getState().focusedNodeId).toBe(r)
  })
})

// =============================================================================
// zoomToSelection — fit and center the current selection.
// =============================================================================

describe('canvasStore.zoomToSelection', () => {
  it('centers the selected node in the viewport', () => {
    const store = createCanvasStore()
    store.getState().setContainerSize({ width: 1000, height: 800 })
    const a = store.getState().addNode('a', 'editor', { x: 0, y: 0 }, { width: 100, height: 100 })
    store.getState().addNode('b', 'editor', { x: 2000, y: 2000 }, { width: 100, height: 100 })
    store.getState().selectNodes([a], false)

    store.getState().zoomToSelection()

    // The selected node's center (50,50) should map to the container center.
    const view = store.getState().canvasToView({ x: 50, y: 50 })
    expect(view.x).toBeCloseTo(500, 0)
    expect(view.y).toBeCloseTo(400, 0)
    expect(store.getState().zoomLevel).toBeGreaterThan(0)
  })

  it('falls back to fitting all nodes when nothing is selected or focused', () => {
    const store = createCanvasStore()
    store.getState().setContainerSize({ width: 1000, height: 800 })
    store.getState().addNode('a', 'editor', { x: 0, y: 0 }, { width: 100, height: 100 })
    store.getState().addNode('b', 'editor', { x: 900, y: 0 }, { width: 100, height: 100 })

    store.getState().zoomToSelection()

    // Both nodes land within the visible viewport (zoomToFit behavior).
    const va = store.getState().canvasToView({ x: 0, y: 0 })
    const vb = store.getState().canvasToView({ x: 1000, y: 100 })
    expect(va.x).toBeGreaterThanOrEqual(0)
    expect(vb.x).toBeLessThanOrEqual(1000)
  })
})

// =============================================================================
// placementCluster — cursor-anchored ghost cluster for interactive placement.
// =============================================================================

describe('canvasStore.placementCluster', () => {
  const VIEWPORT = { offset: { x: 0, y: 0 }, zoom: 1, containerSize: { width: 1000, height: 800 } }

  function node(id: string, x: number, y: number, w = 200, h = 150, creationIndex = 0): CanvasNodeState {
    return {
      id, panelId: `panel-${id}`, origin: { x, y }, size: { width: w, height: h },
      zOrder: 0, creationIndex,
    }
  }
  function toMap(...ns: CanvasNodeState[]): Record<CanvasNodeId, CanvasNodeState> {
    return Object.fromEntries(ns.map((n) => [n.id, n]))
  }
  type R = { origin: { x: number; y: number }; size: { width: number; height: number } }
  const rectsOverlap = (a: R, b: R) =>
    !(a.origin.x + a.size.width <= b.origin.x ||
      b.origin.x + b.size.width <= a.origin.x ||
      a.origin.y + a.size.height <= b.origin.y ||
      b.origin.y + b.size.height <= a.origin.y)
  const rectOf = (c: { point: { x: number; y: number }; size: { width: number; height: number } }): R =>
    ({ origin: c.point, size: c.size })

  it('anchors the primary ghost on the cursor', () => {
    const cursor = { x: 300, y: 300 }
    const cands = placementCluster({}, 'terminal', cursor, VIEWPORT)
    expect(cands.length).toBeGreaterThan(0)
    const primary = cands[0]
    expect(primary.point.x + primary.size.width / 2).toBeCloseTo(cursor.x, -1)
    expect(primary.point.y + primary.size.height / 2).toBeCloseTo(cursor.y, -1)
  })

  it('returns ghosts that never overlap each other', () => {
    const cands = placementCluster(toMap(node('a', 0, 0)), 'terminal', { x: 600, y: 400 }, VIEWPORT)
    expect(cands.length).toBeGreaterThan(1)
    for (let i = 0; i < cands.length; i++) {
      for (let j = i + 1; j < cands.length; j++) {
        expect(rectsOverlap(rectOf(cands[i]), rectOf(cands[j]))).toBe(false)
      }
    }
  })

  it('ghosts never overlap existing nodes', () => {
    const nodes = toMap(node('a', 0, 0), node('b', 400, 0))
    const cands = placementCluster(nodes, 'terminal', { x: 200, y: 100 }, VIEWPORT)
    cands.forEach((c) => {
      Object.values(nodes).forEach((n) =>
        expect(rectsOverlap(rectOf(c), { origin: n.origin, size: n.size })).toBe(false),
      )
    })
  })

  it('offers multiple aspect ratios (size variants)', () => {
    const cands = placementCluster({}, 'terminal', { x: 500, y: 400 }, VIEWPORT)
    const labels = new Set(cands.map((c) => c.sizeLabel))
    expect(labels.size).toBeGreaterThanOrEqual(2)
  })

  it('all ghosts are grid-snapped, ranks sequential from 0', () => {
    const cands = placementCluster(toMap(node('a', 0, 0)), 'terminal', { x: 600, y: 400 }, VIEWPORT)
    cands.forEach((c) => {
      expect(c.point.x % CANVAS_GRID_SIZE === 0).toBe(true)
      expect(c.point.y % CANVAS_GRID_SIZE === 0).toBe(true)
    })
    expect(cands.map((c) => c.rank)).toEqual(cands.map((_, i) => i))
  })

  it('still yields ≥1 overlap-free ghost when the cursor is boxed in', () => {
    const nodes = toMap(
      node('c', 0, 0, 200, 150),
      node('r', 220, 0, 200, 150),
      node('l', -220, 0, 200, 150),
      node('d', 0, 170, 200, 150),
      node('u', 0, -170, 200, 150),
    )
    const cands = placementCluster(nodes, 'terminal', { x: 100, y: 75 }, VIEWPORT)
    expect(cands.length).toBeGreaterThanOrEqual(1)
    cands.forEach((c) => {
      Object.values(nodes).forEach((n) =>
        expect(rectsOverlap(rectOf(c), { origin: n.origin, size: n.size })).toBe(false),
      )
    })
  })

  it('flags off-screen ghosts when the cursor is outside the viewport', () => {
    const cands = placementCluster({}, 'terminal', { x: 5000, y: 5000 }, VIEWPORT)
    expect(cands.length).toBeGreaterThan(0)
    expect(cands.every((c) => c.onScreen === false)).toBe(true)
  })
})

describe('canvasStore.placementSizeVariants', () => {
  it('returns at least two distinct, grid-snapped sizes', () => {
    const variants = placementSizeVariants('terminal')
    expect(variants.length).toBeGreaterThanOrEqual(2)
    const keys = new Set(variants.map((v) => `${v.size.width}x${v.size.height}`))
    expect(keys.size).toBeGreaterThanOrEqual(2)
    variants.forEach((v) => {
      expect(v.size.width % CANVAS_GRID_SIZE === 0).toBe(true)
      expect(v.size.height % CANVAS_GRID_SIZE === 0).toBe(true)
    })
  })
})

// =============================================================================
// Interactive ghost placement — beginPlacement / commitPlacement / cancel.
// =============================================================================

describe('canvasStore ghost placement actions', () => {
  function setup() {
    const store = createCanvasStore()
    store.getState().setContainerSize({ width: 1000, height: 800 })
    return store
  }

  it('beginPlacement sets pendingPlacement and returns true', () => {
    const store = setup()
    const shown = store.getState().beginPlacement('p1', 'terminal')
    expect(shown).toBe(true)
    const pending = store.getState().pendingPlacement
    expect(pending).not.toBeNull()
    expect(pending!.panelId).toBe('p1')
    expect(pending!.candidates.length).toBeGreaterThanOrEqual(1)
  })

  it('commitPlacement creates one node at the chosen spot+size and clears state', () => {
    const store = setup()
    store.getState().addNode('seed', 'editor', { x: 0, y: 0 }, { width: 200, height: 150 })
    store.getState().beginPlacement('p1', 'terminal')
    const target = store.getState().pendingPlacement!.candidates[1] ?? store.getState().pendingPlacement!.candidates[0]
    const idx = store.getState().pendingPlacement!.candidates.indexOf(target)

    const nodeId = store.getState().commitPlacement(idx)
    expect(nodeId).toBeTruthy()
    expect(store.getState().pendingPlacement).toBeNull()
    const node = store.getState().nodes[nodeId!]
    expect(node.panelId).toBe('p1')
    expect(node.origin).toEqual(target.point)
    expect(node.size).toEqual(target.size)
    expect(Object.values(store.getState().nodes).filter((n) => n.panelId === 'p1')).toHaveLength(1)
    expect(store.getState().focusedNodeId).toBe(nodeId)
  })

  it('updatePlacementCursor re-anchors the cluster to the new cursor', () => {
    const store = setup()
    store.getState().beginPlacement('p1', 'terminal')
    const cursor = { x: 250, y: 350 }
    store.getState().updatePlacementCursor(cursor)
    const pending = store.getState().pendingPlacement!
    expect(pending.cursor).toEqual(cursor)
    const primary = pending.candidates[0]
    // Grid-snapping the top-left can shift the centre by up to half a grid cell.
    expect(Math.abs(primary.point.x + primary.size.width / 2 - cursor.x)).toBeLessThanOrEqual(CANVAS_GRID_SIZE / 2)
    expect(Math.abs(primary.point.y + primary.size.height / 2 - cursor.y)).toBeLessThanOrEqual(CANVAS_GRID_SIZE / 2)
  })

  it('cancelPlacement clears state and invokes the rollback callback', () => {
    const store = setup()
    let cancelledId: string | null = null
    store.getState().beginPlacement('p1', 'terminal', (id) => { cancelledId = id })
    store.getState().cancelPlacement()
    expect(store.getState().pendingPlacement).toBeNull()
    expect(cancelledId).toBe('p1')
  })

  it('re-trigger rolls the previous pending panel back (latest wins)', () => {
    const store = setup()
    let cancelledId: string | null = null
    store.getState().beginPlacement('p1', 'terminal', (id) => { cancelledId = id })
    store.getState().beginPlacement('p2', 'terminal', () => {})
    expect(cancelledId).toBe('p1')
    expect(store.getState().pendingPlacement!.panelId).toBe('p2')
  })

  it('setPlacementHover updates the hovered index', () => {
    const store = setup()
    store.getState().beginPlacement('p1', 'terminal')
    store.getState().setPlacementHover(0)
    expect(store.getState().pendingPlacement!.hoveredIndex).toBe(0)
    store.getState().setPlacementHover(null)
    expect(store.getState().pendingPlacement!.hoveredIndex).toBeNull()
  })

  it('commitPlacement is a no-op with an out-of-range index', () => {
    const store = setup()
    store.getState().beginPlacement('p1', 'terminal')
    const result = store.getState().commitPlacement(999)
    expect(result).toBeNull()
    expect(store.getState().pendingPlacement).not.toBeNull()
  })
})
