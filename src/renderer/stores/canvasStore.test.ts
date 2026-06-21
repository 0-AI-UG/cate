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
import { focusedNodeId } from './canvas/selectionModel'
import { recommendPlacements, nudgeToFree } from '../canvas/placement'
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
    expect(focusedNodeId(store.getState())).toBe(id)
  })

  it('focusAndCenter increments focusEpoch', () => {
    const store = createCanvasStore()
    const id = store.getState().addNode('p1', 'terminal', { x: 0, y: 0 }, { width: 100, height: 80 })
    store.getState().setContainerSize({ width: 800, height: 600 })

    const before = store.getState().focusEpoch
    store.getState().focusAndCenter(id)
    expect(store.getState().focusEpoch).toBe(before + 1)
    expect(focusedNodeId(store.getState())).toBe(id)
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
      return focusedNodeId(store.getState())
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
    expect(focusedNodeId(store.getState())).toBe(r)
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
      return [...store.getState().selection]
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
    expect(focusedNodeId(store.getState())).toBeNull()
    expect([...store.getState().selection]).toEqual([r])
  })

  it('uses the focused node as the reference when nothing is selected', () => {
    const { store, c, r } = setup()
    store.getState().focusNode(c)
    store.getState().navigateSelect('right')
    expect([...store.getState().selection]).toEqual([r])
  })

  it('chains: jumping again continues from the newly selected node', () => {
    const { store, c, r } = setup()
    const rr = store.getState().addNode('rr', 'editor', { x: 950, y: -40 }, { width: 100, height: 80 })
    store.getState().selectNodes([c])
    store.getState().navigateSelect('right')
    expect([...store.getState().selection]).toEqual([r])
    store.getState().navigateSelect('right')
    expect([...store.getState().selection]).toEqual([rr])
  })

  it('is a no-op when no node lies in the requested direction', () => {
    const { store, r } = setup()
    store.getState().selectNodes([r]) // rightmost
    store.getState().navigateSelect('right')
    expect([...store.getState().selection]).toEqual([r])
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
    expect(focusedNodeId(store.getState())).toBeNull()
    expect(store.getState().selection.length).toBe(0)
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

// =============================================================================
// recommendPlacements — 3–5 ranked, non-overlapping spots for the ghost picker.
// =============================================================================

describe('canvasStore.recommendPlacements', () => {
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
  // VIEWPORT (offset 0, zoom 1) maps to the canvas rect 0..1000 × 0..800.
  const viewRect: R = { origin: { x: 0, y: 0 }, size: { width: 1000, height: 800 } }
  const onScreen = (c: { point: { x: number; y: number }; size: { width: number; height: number } }) =>
    rectsOverlap(rectOf(c), viewRect)

  it('returns recommendations that never overlap each other', () => {
    const cands = recommendPlacements(toMap(node('a', 0, 0)), 'a', 'terminal', VIEWPORT, null)
    expect(cands.length).toBeGreaterThan(1)
    for (let i = 0; i < cands.length; i++) {
      for (let j = i + 1; j < cands.length; j++) {
        expect(rectsOverlap(rectOf(cands[i]), rectOf(cands[j]))).toBe(false)
      }
    }
  })

  it('recommendations never overlap existing nodes', () => {
    const nodes = toMap(node('a', 0, 0), node('b', 400, 0))
    const cands = recommendPlacements(nodes, 'a', 'terminal', VIEWPORT, null)
    cands.forEach((c) => {
      Object.values(nodes).forEach((n) =>
        expect(rectsOverlap(rectOf(c), { origin: n.origin, size: n.size })).toBe(false),
      )
    })
  })

  it('caps the recommendation count at max', () => {
    const cands = recommendPlacements(toMap(node('a', 0, 0)), 'a', 'terminal', VIEWPORT, null)
    expect(cands.length).toBeLessThanOrEqual(6)
    const three = recommendPlacements(toMap(node('a', 0, 0)), 'a', 'terminal', VIEWPORT, null, 3)
    expect(three.length).toBeLessThanOrEqual(3)
  })

  it('mirrors the neighbor (and placed ghosts) over sizeOverride wherever a neighbor is adjacent', () => {
    const override = { width: 900, height: 700 }
    const node0 = node('a', 0, 0) // 200x150
    const cands = recommendPlacements(toMap(node0), 'a', 'terminal', VIEWPORT, null, 6, override)
    expect(cands.length).toBeGreaterThan(0)
    // Mirror rule: a candidate adjacent to the node OR to an already-placed ghost
    // takes that neighbor's FULL size, clamped to [MIN,MAX] (200x150 → MIN
    // 280x180). Because placed ghosts also act as neighbors, the grid tiles
    // outward and EVERY candidate around the single node mirrors at 280x180 —
    // the override never wins where a neighbor exists.
    cands.forEach((c) => {
      expect(c.size, `every candidate mirrors the node (MIN-clamped): ${JSON.stringify(c)}`)
        .toEqual({ width: 280, height: 180 })
    })
  })

  it('drives the default (best) spot from sizeOverride on an empty canvas, where there is no neighbor to mirror', () => {
    const override = { width: 900, height: 700 }
    const cands = recommendPlacements({}, null, 'terminal', VIEWPORT, { x: 500, y: 400 }, 6, override)
    expect(cands.length).toBeGreaterThan(0)
    // On a blank area the picker offers SIZE choices: the best/first spot uses
    // the override; the others are distinct scaled variants of it.
    expect(cands[0].size).toEqual(override)
    const sizeKeys = cands.map((c) => `${c.size.width}x${c.size.height}`)
    expect(new Set(sizeKeys).size).toBe(cands.length)
  })

  it('biases the best recommendation toward the anchor (mouse) when given', () => {
    const anchor = { x: 300, y: 300 }
    const cands = recommendPlacements({}, null, 'terminal', VIEWPORT, anchor)
    expect(cands.length).toBeGreaterThan(0)
    const best = cands[0]
    expect(best.point.x + best.size.width / 2).toBeCloseTo(anchor.x, -1)
    expect(best.point.y + best.size.height / 2).toBeCloseTo(anchor.y, -1)
  })

  it('all recommendations are grid-snapped', () => {
    const cands = recommendPlacements(toMap(node('a', 0, 0), node('b', 400, 0)), 'a', 'terminal', VIEWPORT, null)
    cands.forEach((c) => {
      expect(c.point.x % CANVAS_GRID_SIZE === 0).toBe(true)
      expect(c.point.y % CANVAS_GRID_SIZE === 0).toBe(true)
    })
  })

  it('still yields ≥1 overlap-free recommendation when the focused node is boxed in', () => {
    const nodes = toMap(
      node('c', 0, 0, 200, 150),
      node('r', 220, 0, 200, 150),
      node('l', -220, 0, 200, 150),
      node('d', 0, 170, 200, 150),
      node('u', 0, -170, 200, 150),
    )
    const cands = recommendPlacements(nodes, 'c', 'terminal', VIEWPORT, null)
    expect(cands.length).toBeGreaterThanOrEqual(1)
    cands.forEach((c) => {
      Object.values(nodes).forEach((n) =>
        expect(rectsOverlap(rectOf(c), { origin: n.origin, size: n.size })).toBe(false),
      )
    })
  })

  const rectGap = (a: R, b: R) => {
    const dx = Math.max(0, a.origin.x - (b.origin.x + b.size.width), b.origin.x - (a.origin.x + a.size.width))
    const dy = Math.max(0, a.origin.y - (b.origin.y + b.size.height), b.origin.y - (a.origin.y + a.size.height))
    return Math.hypot(dx, dy)
  }

  it('on-screen recommendations rank before off-screen ones', () => {
    // Node near the right edge: its right slot is off-screen, others on-screen.
    const cands = recommendPlacements(toMap(node('a', 850, 350)), 'a', 'terminal', VIEWPORT, null)
    const firstOff = cands.findIndex((c) => !onScreen(c))
    const lastOn = cands.map((c) => onScreen(c)).lastIndexOf(true)
    if (firstOff !== -1) expect(firstOff).toBeGreaterThan(lastOn)
    expect(onScreen(cands[0])).toBe(true)
  })

  it('ACTIVE node: the best recommendation sits directly beside the focused node', () => {
    const a = node('a', 400, 320) // on-screen, focused → active
    const cands = recommendPlacements(toMap(a), 'a', 'terminal', VIEWPORT, null)
    expect(cands.length).toBeGreaterThanOrEqual(3)
    // The BEST spot hugs the node (one gap away); the group stays nearby.
    expect(rectGap(rectOf(cands[0]), { origin: a.origin, size: a.size })).toBeLessThanOrEqual(60)
    const pitch = 640 + 40
    cands.forEach((c) => {
      expect(rectGap(rectOf(c), { origin: a.origin, size: a.size })).toBeLessThan(pitch * 2)
    })
  })

  it('ACTIVE node in a cluster: recommendations form one connected group', () => {
    // 2×2 cluster; focus the bottom-right node. Recs must stay attached to it or
    // each other — never flung to the far side of the cluster.
    const nodes = toMap(
      node('tl', 0, 0), node('tr', 240, 0),
      node('bl', 0, 190), node('br', 240, 190, 200, 150, 3),
    )
    const cands = recommendPlacements(nodes, 'br', 'terminal', VIEWPORT, null)
    expect(cands.length).toBeGreaterThanOrEqual(1)
    const br: R = { origin: nodes['br'].origin, size: nodes['br'].size }
    const pitch = 640 + 40 + 5 // new-panel pitch + slack
    cands.forEach((c) => {
      const connected =
        rectGap(rectOf(c), br) <= pitch ||
        cands.some((o) => o !== c && rectGap(rectOf(c), rectOf(o)) <= pitch)
      expect(connected).toBe(true)
    })
  })

  it('MIRRORED SIZE: a side slot mirrors the node on BOTH axes (height capped at MAX), no shrunken sliver', () => {
    // An unusually-shaped (tall) focused node (600x1000). On the LEFT/RIGHT the
    // free slot is tall enough to host the node's full height, so the mirror copies
    // the node's full size onto the candidate, clamped to [MIN,MAX] — width 600,
    // height capped at PLACEMENT_MAX_H (900). The mirror is never a shrunken sliver.
    const a = node('a', 200, 200, 600, 1000)
    const cands = recommendPlacements(toMap(a), 'a', 'terminal', VIEWPORT, null)
    expect(cands.length).toBeGreaterThanOrEqual(1)
    // A side slot mirrors the node: width 600, height clamped to MAX_H (900).
    const sideSlot = cands.find((c) => c.size.width === 600 && c.size.height === 900)
    expect(sideSlot, `expected a side mirror capped at MAX_H: ${JSON.stringify(cands)}`).toBeTruthy()
    // Every mirror (width 600) sits at the MAX_H cap — no shrunken stacked sliver.
    cands
      .filter((c) => c.size.width === 600)
      .forEach((c) => {
        expect(c.size.height, `no shrunken sliver: ${JSON.stringify(c)}`).toBe(900)
      })
  })

  it('MIRROR GRID: a bounded gap mirrors the neighbor size, never grows to fill', () => {
    // Two tall nodes with a wide gap between them. Under the pure mirror grid the
    // gap mirrors a neighbor's FULL size (400x800) rather than growing to fill the
    // 900px gap — no over-wide tile. The mirrored height (800) is clamped to MAX_H.
    const a = node('a', 0, 0, 400, 800)
    const b = node('b', 1300, 0, 400, 800, 1)
    const cands = recommendPlacements(toMap(a, b), 'a', 'terminal', VIEWPORT, null)
    const inGap = cands.find((c) => c.point.x >= 400 && c.point.x + c.size.width <= 1300)
    expect(inGap).toBeDefined()
    // Mirrors the neighbor width (400) — NOT an 820-wide grow-to-fill tile.
    expect(inGap!.size.width).toBe(400)
    // Height mirrored the neighbor (800), within MAX_H.
    expect(inGap!.size.height).toBe(800)
    // No candidate is wider than the neighbor — uniform grid, no fill.
    cands.forEach((c) => expect(c.size.width).toBeLessThanOrEqual(400))
  })

  it('GAP-FILL: a sub-standard gap is SKIPPED under the mirror grid — no custom tile', () => {
    // Two standard (640×400) nodes with a ~460px horizontal gap — too narrow for a
    // mirror of the 640-wide neighbor. Under the pure mirror grid the gap mirrors a
    // 640 neighbor, which does not fit 460, so it is SKIPPED rather than filled with
    // a custom sliver. Every candidate mirrors the neighbor's full size.
    const a = node('a', 0, 0, 640, 400)
    const b = node('b', 1100, 0, 640, 400, 1)
    const cands = recommendPlacements(toMap(a, b), 'a', 'terminal', VIEWPORT, null)
    // No custom-sized tile squeezes into the 460px gap.
    const custom = cands.find((c) => c.size.width !== 640 || c.size.height !== 400)
    expect(custom, `no custom sliver expected: ${JSON.stringify(cands)}`).toBeUndefined()
    cands.forEach((c) => expect(c.size).toEqual({ width: 640, height: 400 }))
  })

  it('GAP-FILL: a staggered layout tiles the irregular hole with neighbor-sized ghosts', () => {
    // Two diagonally-offset, equal-sized nodes leave an L-shaped empty region a
    // pairwise gap check would miss — the rectangle finder fills its holes. With
    // placed ghosts acting as mirror neighbors the region tiles UNIFORMLY at the
    // node size (400x300) instead of producing an odd custom box, but a ghost
    // still lands in the hole, clear of both nodes and on the grid.
    const a = node('a', 0, 0, 400, 300)
    const b = node('b', 600, 360, 400, 300, 1)
    const cands = recommendPlacements(toMap(a, b), 'a', 'terminal', VIEWPORT, null)
    // Every ghost mirrors the (equal) node size — the grid is uniform.
    cands.forEach((c) =>
      expect(c.size, `mirrors the node size: ${JSON.stringify(c)}`).toEqual({ width: 400, height: 300 }),
    )
    // A ghost fills the hole region (within the bounding box of the two nodes),
    // overlapping neither node.
    const filler = cands.find(
      (c) =>
        c.point.x >= 0 && c.point.x + c.size.width <= 1000 &&
        c.point.y >= 0 && c.point.y + c.size.height <= 660,
    )
    expect(filler, `expected a hole-filling ghost: ${JSON.stringify(cands)}`).toBeDefined()
    expect(rectsOverlap(rectOf(filler!), { origin: a.origin, size: a.size })).toBe(false)
    expect(rectsOverlap(rectOf(filler!), { origin: b.origin, size: b.size })).toBe(false)
    expect(filler!.point.x % CANVAS_GRID_SIZE).toBe(0)
    expect(filler!.point.y % CANVAS_GRID_SIZE).toBe(0)
  })

  it('GAP-FILL: a gap below the minimum gets no recommendation', () => {
    const a = node('a', 0, 0, 640, 400)
    const b = node('b', 840, 0, 640, 400, 1) // only a 200px gap → too small
    const cands = recommendPlacements(toMap(a, b), 'a', 'terminal', VIEWPORT, null)
    // No candidate squeezes into the tiny gap (640 < x < 840).
    cands.forEach((c) => {
      const insideGap = c.point.x > 640 && c.point.x + c.size.width < 840
      expect(insideGap).toBe(false)
    })
  })

  it('ISLANDS: with no active node, recommends around the island nearest the anchor', () => {
    const near = node('near', 0, 0)
    const far = node('far', 5000, 5000, 200, 150, 1)
    const nodes = toMap(near, far)
    // No focus; anchor sits on the near island.
    const cands = recommendPlacements(nodes, null, 'terminal', VIEWPORT, { x: 100, y: 75 })
    expect(cands.length).toBeGreaterThan(0)
    cands.forEach((c) => {
      expect(rectGap(rectOf(c), { origin: near.origin, size: near.size }))
        .toBeLessThan(rectGap(rectOf(c), { origin: far.origin, size: far.size }))
    })
  })

  it('BLANK viewport: no active node and nothing on screen → centre on the view', () => {
    // The only node is far off-screen and not focused.
    const cands = recommendPlacements(toMap(node('off', 4000, 4000)), null, 'terminal', VIEWPORT, null)
    expect(cands.length).toBeGreaterThan(0)
    expect(onScreen(cands[0])).toBe(true)
    // Best ghost is centred on the viewport centre (500, 400).
    expect(Math.abs(cands[0].point.x + cands[0].size.width / 2 - 500)).toBeLessThanOrEqual(CANVAS_GRID_SIZE)
    expect(Math.abs(cands[0].point.y + cands[0].size.height / 2 - 400)).toBeLessThanOrEqual(CANVAS_GRID_SIZE)
  })

  it('BOXED-IN: a surrounded focused node still surfaces several spots beyond the ring', () => {
    // The old lattice/BFS died to a single fallback spot once every neighbour cell
    // was occupied. Decomposing the free space reaches the open area past the ring.
    const nodes = toMap(
      node('c', 0, 0, 200, 150),
      node('r', 220, 0, 200, 150),
      node('l', -220, 0, 200, 150),
      node('d', 0, 170, 200, 150),
      node('u', 0, -170, 200, 150),
    )
    const cands = recommendPlacements(nodes, 'c', 'terminal', VIEWPORT, null)
    expect(cands.length).toBeGreaterThanOrEqual(3)
    cands.forEach((c) => {
      Object.values(nodes).forEach((n) =>
        expect(rectsOverlap(rectOf(c), { origin: n.origin, size: n.size })).toBe(false),
      )
    })
  })

  it('FOCUS vs CURSOR: focus pulls the best spot to the node; no focus follows the cursor', () => {
    // Big viewport, nodes far apart so the best spot can hug one without reaching the other.
    const VP = { offset: { x: 0, y: 0 }, zoom: 1, containerSize: { width: 1800, height: 1400 } }
    const a = node('a', 100, 100, 300, 220)
    const b = node('b', 1300, 1000, 300, 220, 1)
    const nodes = toMap(a, b)
    const aR: R = { origin: a.origin, size: a.size }
    const bR: R = { origin: b.origin, size: b.size }

    // Focused on A (no cursor) → the best spot hugs A, not B.
    const focused = recommendPlacements(nodes, 'a', 'terminal', VP, null)
    expect(rectGap(rectOf(focused[0]), aR)).toBeLessThan(rectGap(rectOf(focused[0]), bR))

    // Nothing focused, cursor by B → the best spot follows the cursor to B, not A.
    const free = recommendPlacements(nodes, null, 'terminal', VP, { x: 1280, y: 980 })
    expect(rectGap(rectOf(free[0]), bR)).toBeLessThan(rectGap(rectOf(free[0]), aR))
  })

  it('HUG SNAP: a node with a non-grid-aligned edge still gets a spot directly beside it', () => {
    // The right edge (843) isn't on the 20px grid. The hug anchor must snap AWAY
    // from the node so grid-snapping doesn't eat the gap and make finalize drop it.
    const a = node('a', 200, 200, 643, 411)
    const cands = recommendPlacements(toMap(a), 'a', 'terminal', VIEWPORT, null)
    const aRight = a.origin.x + a.size.width
    const beside = cands.find(
      (c) =>
        c.point.x >= aRight && c.point.x <= aRight + 60 && // just to the right, gap preserved
        c.point.y < a.origin.y + a.size.height && c.point.y + c.size.height > a.origin.y, // shares its rows
    )
    expect(beside).toBeDefined()
    expect(rectsOverlap(rectOf(beside!), { origin: a.origin, size: a.size })).toBe(false)
  })

  it('CONNECTED: no recommendation lands past a neighbour blocking the node', () => {
    // A neighbour directly to the right blocks that side; the free space far past
    // it must NOT be recommended — recs form one cluster touching the node.
    const VP = { offset: { x: 0, y: 0 }, zoom: 0.5, containerSize: { width: 2400, height: 1800 } }
    const foc = node('foc', 1000, 1000, 640, 400, 9)
    const blocker = node('r', 1680, 1000, 640, 400, 1)
    const cands = recommendPlacements(toMap(foc, blocker), 'foc', 'terminal', VP, null)
    const blockerRight = blocker.origin.x + blocker.size.width
    expect(cands.length).toBeGreaterThanOrEqual(1)
    cands.forEach((c) => expect(c.point.x).toBeLessThan(blockerRight))
  })

  it('NO GIANT GAPS: focused recommendations stay clustered near the node', () => {
    // Box the focused node tightly on three sides, leaving far-open space. Recs
    // must hug the node, not scatter into the distance to fill the count.
    const VP = { offset: { x: 0, y: 0 }, zoom: 1, containerSize: { width: 2600, height: 2200 } }
    const foc = node('foc', 1000, 1000, 640, 400, 9)
    const nodes = toMap(
      foc,
      node('up', 1000, 560, 640, 400, 1),
      node('down', 1000, 1440, 640, 400, 2),
      node('left', 320, 1000, 640, 400, 3),
    )
    const cands = recommendPlacements(nodes, 'foc', 'terminal', VP, null)
    const focR: R = { origin: foc.origin, size: foc.size }
    const pitch = 640 + 40
    expect(cands.length).toBeGreaterThanOrEqual(1)
    cands.forEach((c) => expect(rectGap(rectOf(c), focR)).toBeLessThanOrEqual(pitch))
  })

  it('PACKING: spots never overlap each other or any node', () => {
    // The packer carves each placed ghost (plus its gap) out of the free space, so
    // recommendations are always mutually non-overlapping and clear of every window.
    const VP = { offset: { x: 0, y: 0 }, zoom: 1, containerSize: { width: 2600, height: 1400 } }
    const nodes = toMap(
      node('a', 400, 300, 640, 400, 1),
      node('b', 1200, 360, 600, 500, 2),
      node('c', 500, 900, 700, 360, 3),
    )
    const cands = recommendPlacements(nodes, 'a', 'terminal', VP, null)
    for (let i = 0; i < cands.length; i++) {
      Object.values(nodes).forEach((n) =>
        expect(rectsOverlap(rectOf(cands[i]), { origin: n.origin, size: n.size })).toBe(false),
      )
      for (let j = i + 1; j < cands.length; j++) {
        expect(rectsOverlap(rectOf(cands[i]), rectOf(cands[j]))).toBe(false)
      }
    }
  })
})

describe('canvasStore.nudgeToFree', () => {
  const size = { width: 200, height: 150 }
  const node = (id: string, x: number, y: number) => ({
    id, panelId: `p-${id}`, origin: { x, y }, size, zOrder: 0, creationIndex: 0,
  })
  const toMap = (...ns: ReturnType<typeof node>[]) => Object.fromEntries(ns.map((n) => [n.id, n]))
  const overlaps = (a: { origin: { x: number; y: number }; size: { width: number; height: number } }, p: { x: number; y: number }) =>
    !(a.origin.x + a.size.width <= p.x || p.x + size.width <= a.origin.x ||
      a.origin.y + a.size.height <= p.y || p.y + size.height <= a.origin.y)

  it('returns the snapped point when it is already free', () => {
    const p = nudgeToFree({}, size, { x: 305, y: 207 })
    expect(p.x % CANVAS_GRID_SIZE === 0).toBe(true)
    expect(p.y % CANVAS_GRID_SIZE === 0).toBe(true)
  })

  it('pushes off an overlapping node to a free spot', () => {
    const nodes = toMap(node('a', 0, 0))
    const p = nudgeToFree(nodes, size, { x: 10, y: 10 }) // would land on top of 'a'
    expect(overlaps(nodes['a'], p)).toBe(false)
  })
})

// =============================================================================
// Interactive ghost placement — beginPlacement / commitPlacement / cancel.
// =============================================================================

describe('canvasStore ghost placement actions', () => {
  // The ghost picker only kicks in on a non-empty canvas, so seed a background
  // node by default. Tests that need a blank canvas build their own bare store.
  function setup() {
    const store = createCanvasStore()
    store.getState().setContainerSize({ width: 1000, height: 800 })
    store.getState().addNode('seed', 'editor', { x: 0, y: 0 }, { width: 200, height: 150 })
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

  it('beginPlacement captures the dev placement trace on pendingPlacement', () => {
    // Vitest runs with import.meta.env.DEV truthy, so the dev-only trace capture
    // is active here. (Verified: import.meta.env.DEV === true under vitest.)
    const store = setup()
    store.getState().beginPlacement('p1', 'terminal')
    const pending = store.getState().pendingPlacement
    expect(pending).not.toBeNull()
    expect(pending!.trace).toBeDefined()
    expect(pending!.trace!.steps.length).toBeGreaterThan(0)
    expect(pending!.trace!.guides).toBeDefined()
  })

  it('beginPlacement on an empty canvas skips the picker and drops the panel at the camera centre', () => {
    const store = createCanvasStore()
    store.getState().setContainerSize({ width: 1000, height: 800 })
    const shown = store.getState().beginPlacement('p1', 'terminal')
    // No ghosts — placed immediately.
    expect(shown).toBe(true)
    expect(store.getState().pendingPlacement).toBeNull()
    const nodes = Object.values(store.getState().nodes)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].panelId).toBe('p1')
    // Centred on the viewport (1000x800 at zoom 1, offset 0,0 → canvas centre 500,400).
    const { origin, size } = nodes[0]
    expect(origin.x + size.width / 2).toBeCloseTo(500)
    expect(origin.y + size.height / 2).toBeCloseTo(400)
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
    expect(focusedNodeId(store.getState())).toBe(nodeId)
  })

  it('beginPlacement only ever zooms out, and cancel restores the viewport', () => {
    const store = setup()
    // Two far-apart nodes force a zoom-out to fit the recommendations.
    store.getState().addNode('a', 'editor', { x: 0, y: 0 }, { width: 400, height: 300 })
    store.getState().addNode('b', 'editor', { x: 4000, y: 3000 }, { width: 400, height: 300 })
    const zoomBefore = store.getState().zoomLevel
    const offsetBefore = store.getState().viewportOffset
    store.getState().beginPlacement('p1', 'terminal')
    expect(store.getState().zoomLevel).toBeLessThanOrEqual(zoomBefore)
    expect(store.getState().pendingPlacement!.prevZoom).toBe(zoomBefore)
    store.getState().cancelPlacement()
    expect(store.getState().zoomLevel).toBe(zoomBefore)
    expect(store.getState().viewportOffset).toEqual(offsetBefore)
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

  it('updatePlacementCursor previews a free spot under the cursor', () => {
    const store = setup()
    store.getState().beginPlacement('p1', 'terminal')
    store.getState().updatePlacementCursor({ x: 700, y: 500 })
    const free = store.getState().pendingPlacement!.freeGhost!
    expect(free).not.toBeNull()
    // Centre of the free ghost tracks the cursor (within grid-snap tolerance).
    expect(Math.abs(free.point.x + free.size.width / 2 - 700)).toBeLessThanOrEqual(CANVAS_GRID_SIZE / 2)
    expect(Math.abs(free.point.y + free.size.height / 2 - 500)).toBeLessThanOrEqual(CANVAS_GRID_SIZE / 2)
  })

  it('F arms free placement; disarming clears the preview ghost', () => {
    const store = setup()
    store.getState().beginPlacement('p1', 'terminal')
    expect(store.getState().pendingPlacement!.freeArmed).toBe(false)
    store.getState().setFreeArmed(true)
    expect(store.getState().pendingPlacement!.freeArmed).toBe(true)
    store.getState().updatePlacementCursor({ x: 700, y: 500 })
    expect(store.getState().pendingPlacement!.freeGhost).not.toBeNull()
    store.getState().setFreeArmed(false)
    expect(store.getState().pendingPlacement!.freeArmed).toBe(false)
    expect(store.getState().pendingPlacement!.freeGhost).toBeNull()
  })

  it('commitFreePlacement creates a node centred on the click point and clears state', () => {
    const store = setup()
    store.getState().beginPlacement('p1', 'terminal')
    const nodeId = store.getState().commitFreePlacement({ x: 650, y: 450 })
    expect(nodeId).toBeTruthy()
    expect(store.getState().pendingPlacement).toBeNull()
    const node = store.getState().nodes[nodeId!]
    expect(node.panelId).toBe('p1')
    expect(Math.abs(node.origin.x + node.size.width / 2 - 650)).toBeLessThanOrEqual(CANVAS_GRID_SIZE / 2)
    expect(focusedNodeId(store.getState())).toBe(nodeId)
  })
})
