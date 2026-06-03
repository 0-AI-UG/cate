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
import { createCanvasStore } from './canvasStore'

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
// navigateSelect — Cmd+Arrow node jumping that selects without activating.
// =============================================================================

describe('canvasStore.navigateSelect', () => {
  function setup() {
    const store = createCanvasStore()
    store.getState().setContainerSize({ width: 1000, height: 800 })
    const c = store.getState().addNode('c', 'editor', { x: -50, y: -40 }, { width: 100, height: 80 })
    const r = store.getState().addNode('r', 'editor', { x: 450, y: -40 }, { width: 100, height: 80 })
    const l = store.getState().addNode('l', 'editor', { x: -550, y: -40 }, { width: 100, height: 80 })
    const u = store.getState().addNode('u', 'editor', { x: -50, y: -540 }, { width: 100, height: 80 })
    const d = store.getState().addNode('d', 'editor', { x: -50, y: 460 }, { width: 100, height: 80 })
    return { store, c, r, l, u, d }
  }

  it('moves the selection to the nearest node in each direction', () => {
    const { store, c, r, l, u, d } = setup()
    const nav = (dir: 'up' | 'down' | 'left' | 'right') => {
      store.getState().selectNodes([c])
      store.getState().navigateSelect(dir)
      return [...store.getState().selectedNodeIds]
    }
    expect(nav('right')).toEqual([r])
    expect(nav('left')).toEqual([l])
    expect(nav('up')).toEqual([u])
    expect(nav('down')).toEqual([d])
  })

  it('does NOT activate (focus) the destination, so arrows keep jumping', () => {
    const { store, c, r } = setup()
    store.getState().focusNode(c)
    store.getState().navigateSelect('right')
    expect(store.getState().focusedNodeId).toBeNull()
    expect([...store.getState().selectedNodeIds]).toEqual([r])
  })

  it('uses the focused node as the reference when nothing is selected', () => {
    const { store, c, r } = setup()
    store.getState().focusNode(c)
    store.getState().navigateSelect('right')
    expect([...store.getState().selectedNodeIds]).toEqual([r])
  })

  it('chains: jumping again continues from the newly selected node', () => {
    const { store, c, r } = setup()
    const rr = store.getState().addNode('rr', 'editor', { x: 950, y: -40 }, { width: 100, height: 80 })
    store.getState().selectNodes([c])
    store.getState().navigateSelect('right')
    expect([...store.getState().selectedNodeIds]).toEqual([r])
    store.getState().navigateSelect('right')
    expect([...store.getState().selectedNodeIds]).toEqual([rr])
  })

  it('is a no-op when no node lies in the requested direction', () => {
    const { store, r } = setup()
    store.getState().selectNodes([r]) // rightmost
    store.getState().navigateSelect('right')
    expect([...store.getState().selectedNodeIds]).toEqual([r])
  })

  it('suppresses auto-focus on jump, and resumes it on explicit focus or manual pan', () => {
    const { store, c, r } = setup()
    store.getState().selectNodes([c])
    store.getState().navigateSelect('right')
    expect(store.getState().suppressAutoFocus).toBe(true)

    // Clicking / explicitly focusing a node resumes auto-focus.
    store.getState().focusNode(r)
    expect(store.getState().suppressAutoFocus).toBe(false)

    // A keyboard pan suppresses again; a manual pan resumes.
    store.getState().panViewport('left')
    expect(store.getState().suppressAutoFocus).toBe(true)
    store.getState().setViewportOffset({ x: 10, y: 10 })
    expect(store.getState().suppressAutoFocus).toBe(false)
  })
})

// =============================================================================
// panViewport — Shift+Arrow canvas panning.
// =============================================================================

describe('canvasStore.panViewport', () => {
  it('pans the viewport one step per direction without touching selection/focus', () => {
    const store = createCanvasStore()
    store.getState().setViewportOffset({ x: 0, y: 0 })

    store.getState().panViewport('right')
    expect(store.getState().viewportOffset.x).toBeLessThan(0)
    store.getState().panViewport('left') // back to start
    expect(store.getState().viewportOffset.x).toBeCloseTo(0)

    store.getState().setViewportOffset({ x: 0, y: 0 })
    store.getState().panViewport('down')
    expect(store.getState().viewportOffset.y).toBeLessThan(0)
    store.getState().setViewportOffset({ x: 0, y: 0 })
    store.getState().panViewport('up')
    expect(store.getState().viewportOffset.y).toBeGreaterThan(0)

    // No selection/focus side effects.
    expect(store.getState().focusedNodeId).toBeNull()
    expect(store.getState().selectedNodeIds.size).toBe(0)
  })

  it('left and right pan by equal and opposite amounts', () => {
    const store = createCanvasStore()
    store.getState().setViewportOffset({ x: 0, y: 0 })
    store.getState().panViewport('left')
    const left = store.getState().viewportOffset.x
    store.getState().setViewportOffset({ x: 0, y: 0 })
    store.getState().panViewport('right')
    const right = store.getState().viewportOffset.x
    expect(left).toBeCloseTo(-right)
    expect(left).toBeGreaterThan(0)
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
