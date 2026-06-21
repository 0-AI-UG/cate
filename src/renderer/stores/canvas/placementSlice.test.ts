// =============================================================================
// Placement slice — behavioral tests for the interactive ghost-placement
// transaction: beginPlacement snapshots the viewport and zooms out;
// commit/cancel must resolve the transaction exactly once (place the node OR
// restore the viewport + roll back the orphan panel record via onCancelled);
// free "click-anywhere" mode and hover are transaction-scoped sub-state.
// Driven end-to-end through the real composed canvas store — no mocks.
// =============================================================================

import { describe, it, expect, vi } from 'vitest'
import { createCanvasStore } from '../canvasStore'
import { focusedNodeId } from './selectionModel'
import { ZOOM_MIN, PANEL_DEFAULT_SIZES } from '../../../shared/types'
import { rectsOverlap } from '../../canvas/layoutEngine'

const SEED_SIZE = { width: 640, height: 400 }
const CONTAINER = { width: 1200, height: 800 }

/** Store with one focused 640x400 node at the origin — the canonical
 *  "place a second panel" scenario that triggers the interactive picker. */
function storeWithSeed(zoom = 1, offset = { x: 0, y: 0 }) {
  const store = createCanvasStore()
  store.getState().setContainerSize(CONTAINER)
  const seed = store.getState().addNode('seed-panel', 'terminal', { x: 0, y: 0 }, SEED_SIZE)
  store.getState().focusNode(seed)
  store.getState().setZoomAndOffset(zoom, offset)
  return { store, seed }
}

function nodeCount(store: ReturnType<typeof createCanvasStore>) {
  return Object.keys(store.getState().nodes).length
}

describe('beginPlacement', () => {
  it('on an empty canvas skips the picker and drops the panel at the viewport centre', () => {
    const store = createCanvasStore()
    store.getState().setContainerSize(CONTAINER)
    const onCancelled = vi.fn()

    const shown = store.getState().beginPlacement('p1', 'terminal', onCancelled)

    expect(shown).toBe(true)
    expect(store.getState().pendingPlacement).toBeNull() // no transaction opened
    const nodes = Object.values(store.getState().nodes)
    expect(nodes).toHaveLength(1)
    // 640x400 terminal centred on the view centre (600,400) → top-left (280,200).
    expect(nodes[0].origin).toEqual({ x: 280, y: 200 })
    expect(nodes[0].size).toEqual(PANEL_DEFAULT_SIZES.terminal)
    expect(focusedNodeId(store.getState())).toBe(nodes[0].id)
    expect(onCancelled).not.toHaveBeenCalled()
  })

  it('on an empty canvas with an unmeasured container falls back to the default origin', () => {
    const store = createCanvasStore() // containerSize stays 0x0

    const shown = store.getState().beginPlacement('p1', 'editor')

    expect(shown).toBe(true)
    const nodes = Object.values(store.getState().nodes)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].origin).toEqual({ x: 100, y: 100 }) // findFreePosition default
  })

  it('snapshots zoom/offset, zooms out to fit the ghosts, and populates candidate state', () => {
    const { store } = storeWithSeed(1.5, { x: 120, y: -40 })

    const shown = store.getState().beginPlacement('p2', 'terminal')

    expect(shown).toBe(true)
    const pending = store.getState().pendingPlacement
    expect(pending).not.toBeNull()
    // Snapshot is the viewport at begin time, byte-exact.
    expect(pending!.prevZoom).toBe(1.5)
    expect(pending!.prevOffset).toEqual({ x: 120, y: -40 })
    // The ghosts around a 640x400 node can't fit at 1.5x in a 1200x800 view →
    // the camera zoomed OUT (never below the floor) and recentred.
    expect(store.getState().zoomLevel).toBeLessThan(1.5)
    expect(store.getState().zoomLevel).toBeGreaterThanOrEqual(ZOOM_MIN)
    expect(store.getState().viewportOffset).not.toEqual({ x: 120, y: -40 })
    // Fresh transaction sub-state.
    expect(pending!.candidates.length).toBeGreaterThanOrEqual(1)
    expect(pending!.candidates.length).toBeLessThanOrEqual(6)
    expect(pending!.hoveredIndex).toBeNull()
    expect(pending!.freeArmed).toBe(false)
    expect(pending!.freeGhost).toBeNull()
    expect(pending!.size).toEqual(PANEL_DEFAULT_SIZES.terminal)
    // The node itself is NOT created yet — only the ghost transaction.
    expect(nodeCount(store)).toBe(1)
  })

  it('only ever zooms OUT — already zoomed out further than the fit, zoom is untouched', () => {
    const { store } = storeWithSeed(ZOOM_MIN, { x: 0, y: 0 })

    store.getState().beginPlacement('p2', 'terminal')

    expect(store.getState().pendingPlacement).not.toBeNull()
    expect(store.getState().zoomLevel).toBe(ZOOM_MIN)
  })

  it('honors an explicit size override for the ghosts and the placed node', () => {
    const { store } = storeWithSeed()
    const size = { width: 400, height: 300 }

    store.getState().beginPlacement('p2', 'terminal', undefined, size)

    const pending = store.getState().pendingPlacement!
    expect(pending.size).toEqual(size)
    const id = store.getState().commitFreePlacement({ x: 5000, y: 5000 })!
    expect(store.getState().nodes[id].size).toEqual(size)
  })

  it('anchors recommendations to the last pointer position when nothing is focused', () => {
    // The pure mirror grid only offers a spot big enough to host a full-size mirror
    // of the seed (640x400), so give the viewport room around the seed on every
    // side — otherwise the pointer-side region is too small for a tile and is
    // skipped. With room, the best ghost still lands on the pointer's side.
    const ROOMY = { width: 2600, height: 2000 }
    const make = (pointer: { x: number; y: number }) => {
      const store = createCanvasStore()
      store.getState().setContainerSize(ROOMY)
      store.getState().setZoomAndOffset(1, { x: 700, y: 500 }) // seed centred with margin
      store.getState().addNode('seed', 'terminal', { x: 0, y: 0 }, SEED_SIZE) // not focused
      store.getState().setPlacementPointer(pointer)
      store.getState().beginPlacement('p2', 'terminal')
      return store.getState().pendingPlacement!.candidates[0]
    }

    const towardRight = make({ x: 1100, y: 200 })
    const towardBottom = make({ x: 300, y: 700 })

    // Best ghost lands on the pointer's side of the seed node.
    expect(towardRight.point.x).toBeGreaterThanOrEqual(640)
    expect(towardBottom.point.y).toBeGreaterThanOrEqual(400)
    expect(towardRight.point).not.toEqual(towardBottom.point)
  })
})

describe('commitPlacement', () => {
  it('places the node exactly once at the chosen candidate, restores zoom, and recentres on the node', () => {
    const { store } = storeWithSeed(1.5, { x: 120, y: -40 })
    const onCancelled = vi.fn()
    store.getState().beginPlacement('p2', 'terminal', onCancelled)
    const candidate = store.getState().pendingPlacement!.candidates[0]

    const nodeId = store.getState().commitPlacement(0)

    expect(nodeId).not.toBeNull()
    const s = store.getState()
    expect(s.pendingPlacement).toBeNull()
    // Exactly one new node, exactly at the candidate rect.
    expect(nodeCount(store)).toBe(2)
    expect(s.nodes[nodeId!].origin).toEqual(candidate.point)
    expect(s.nodes[nodeId!].size).toEqual(candidate.size)
    expect(s.nodes[nodeId!].panelId).toBe('p2')
    // Zoom is restored to the snapshot; the offset is intentionally NOT the
    // snapshot — commit recentres the camera on the freshly placed node.
    expect(s.zoomLevel).toBe(1.5)
    const cx = candidate.point.x + candidate.size.width / 2
    const cy = candidate.point.y + candidate.size.height / 2
    expect(s.viewportOffset.x).toBeCloseTo(CONTAINER.width / 2 - cx * 1.5)
    expect(s.viewportOffset.y).toBeCloseTo(CONTAINER.height / 2 - cy * 1.5)
    expect(focusedNodeId(s)).toBe(nodeId)
    // Commit is the success path — the rollback callback must never fire.
    expect(onCancelled).not.toHaveBeenCalled()
  })

  it('rejects an out-of-range candidate index and keeps the transaction pending', () => {
    const { store } = storeWithSeed()
    store.getState().beginPlacement('p2', 'terminal')
    const pendingBefore = store.getState().pendingPlacement!
    const zoomBefore = store.getState().zoomLevel

    expect(store.getState().commitPlacement(99)).toBeNull()
    expect(store.getState().commitPlacement(-1)).toBeNull()

    // Nothing placed, nothing restored, transaction object untouched.
    expect(nodeCount(store)).toBe(1)
    expect(store.getState().pendingPlacement).toBe(pendingBefore)
    expect(store.getState().zoomLevel).toBe(zoomBefore)
    // A valid commit still succeeds afterwards.
    expect(store.getState().commitPlacement(0)).not.toBeNull()
    expect(nodeCount(store)).toBe(2)
  })

  it('called twice only places once — the second commit is a rejected no-op', () => {
    const { store } = storeWithSeed()
    store.getState().beginPlacement('p2', 'terminal')

    const first = store.getState().commitPlacement(0)
    const second = store.getState().commitPlacement(0)

    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect(nodeCount(store)).toBe(2)
  })

  it('is a no-op when no placement is pending', () => {
    const { store } = storeWithSeed()
    expect(store.getState().commitPlacement(0)).toBeNull()
    expect(nodeCount(store)).toBe(1)
  })
})

describe('cancelPlacement', () => {
  it('restores the snapshotted zoom/offset exactly and fires onCancelled with the panel id', () => {
    const { store } = storeWithSeed(1.5, { x: 120, y: -40 })
    const onCancelled = vi.fn()
    store.getState().beginPlacement('p2', 'terminal', onCancelled)
    expect(store.getState().zoomLevel).not.toBe(1.5) // sanity: we actually zoomed out

    store.getState().cancelPlacement()

    const s = store.getState()
    expect(s.pendingPlacement).toBeNull()
    expect(s.zoomLevel).toBe(1.5)
    expect(s.viewportOffset).toEqual({ x: 120, y: -40 })
    expect(nodeCount(store)).toBe(1) // no node was placed
    expect(onCancelled).toHaveBeenCalledTimes(1)
    expect(onCancelled).toHaveBeenCalledWith('p2')
  })

  it('cancel mid-placement with the free ghost armed still restores and rolls back cleanly', () => {
    const { store } = storeWithSeed(1.2, { x: 7, y: 13 })
    const onCancelled = vi.fn()
    store.getState().beginPlacement('p2', 'terminal', onCancelled)
    store.getState().setFreeArmed(true)
    store.getState().updatePlacementCursor({ x: 2000, y: 2000 })
    expect(store.getState().pendingPlacement!.freeGhost).not.toBeNull()

    store.getState().cancelPlacement() // Escape

    expect(store.getState().pendingPlacement).toBeNull()
    expect(store.getState().zoomLevel).toBe(1.2)
    expect(store.getState().viewportOffset).toEqual({ x: 7, y: 13 })
    expect(onCancelled).toHaveBeenCalledTimes(1)
  })

  it('after a commit is a no-op — no double restore, no spurious rollback', () => {
    const { store } = storeWithSeed(1.5, { x: 120, y: -40 })
    const onCancelled = vi.fn()
    store.getState().beginPlacement('p2', 'terminal', onCancelled)
    store.getState().commitPlacement(0)
    const zoomAfterCommit = store.getState().zoomLevel
    const offsetAfterCommit = store.getState().viewportOffset

    store.getState().cancelPlacement()

    expect(store.getState().zoomLevel).toBe(zoomAfterCommit)
    expect(store.getState().viewportOffset).toBe(offsetAfterCommit)
    expect(nodeCount(store)).toBe(2) // placed node survives
    expect(onCancelled).not.toHaveBeenCalled()
  })

  it('double cancel only restores and rolls back once', () => {
    const { store } = storeWithSeed(1.5, { x: 0, y: 0 })
    const onCancelled = vi.fn()
    store.getState().beginPlacement('p2', 'terminal', onCancelled)

    store.getState().cancelPlacement()
    store.getState().setZoom(0.8) // user moves on
    store.getState().cancelPlacement() // stray second Escape

    expect(store.getState().zoomLevel).toBe(0.8) // not yanked back to 1.5
    expect(onCancelled).toHaveBeenCalledTimes(1)
  })
})

describe('free "place anywhere" mode', () => {
  it('arming, previewing, and disarming are transaction-scoped', () => {
    const { store } = storeWithSeed()
    store.getState().beginPlacement('p2', 'terminal')

    store.getState().setFreeArmed(true)
    expect(store.getState().pendingPlacement!.freeArmed).toBe(true)

    // Cursor centred on the seed node → ghost is nudged to a free, non-
    // overlapping spot rather than previewing an overlap.
    store.getState().updatePlacementCursor({ x: 320, y: 200 })
    const ghost = store.getState().pendingPlacement!.freeGhost
    expect(ghost).not.toBeNull()
    expect(
      rectsOverlap(
        { origin: ghost!.point, size: ghost!.size },
        { origin: { x: 0, y: 0 }, size: SEED_SIZE },
      ),
    ).toBe(false)

    // Re-sending the same cursor position must not churn state objects.
    const before = store.getState().pendingPlacement
    store.getState().updatePlacementCursor({ x: 320, y: 200 })
    expect(store.getState().pendingPlacement).toBe(before)

    // Disarming clears the ghost preview.
    store.getState().setFreeArmed(false)
    expect(store.getState().pendingPlacement!.freeArmed).toBe(false)
    expect(store.getState().pendingPlacement!.freeGhost).toBeNull()
  })

  it('commitFreePlacement places once at the nudged spot, restores zoom, and ends the transaction', () => {
    const { store } = storeWithSeed(1.5, { x: 0, y: 0 })
    const onCancelled = vi.fn()
    store.getState().beginPlacement('p2', 'terminal', onCancelled)

    // Click directly on top of the seed node — the drop must be nudged free.
    const nodeId = store.getState().commitFreePlacement({ x: 320, y: 200 })

    expect(nodeId).not.toBeNull()
    const s = store.getState()
    expect(s.pendingPlacement).toBeNull()
    expect(nodeCount(store)).toBe(2)
    const placed = s.nodes[nodeId!]
    expect(
      rectsOverlap(
        { origin: placed.origin, size: placed.size },
        { origin: { x: 0, y: 0 }, size: SEED_SIZE },
      ),
    ).toBe(false)
    expect(s.zoomLevel).toBe(1.5)
    expect(focusedNodeId(s)).toBe(nodeId)
    expect(onCancelled).not.toHaveBeenCalled()
    // Transaction is closed: a second free commit does nothing.
    expect(store.getState().commitFreePlacement({ x: 9000, y: 9000 })).toBeNull()
    expect(nodeCount(store)).toBe(2)
  })

  it('free-mode actions are no-ops while no placement is pending', () => {
    const { store } = storeWithSeed()
    const before = store.getState()

    store.getState().setFreeArmed(true)
    store.getState().updatePlacementCursor({ x: 50, y: 50 })
    store.getState().setPlacementHover(1)

    expect(store.getState().pendingPlacement).toBeNull()
    expect(store.getState().nodes).toBe(before.nodes)
    expect(store.getState().commitFreePlacement({ x: 50, y: 50 })).toBeNull()
  })
})

describe('setPlacementHover', () => {
  it('sets and clears the hovered candidate without disturbing the rest of the transaction', () => {
    const { store } = storeWithSeed()
    store.getState().beginPlacement('p2', 'terminal')
    const candidates = store.getState().pendingPlacement!.candidates

    store.getState().setPlacementHover(1)
    expect(store.getState().pendingPlacement!.hoveredIndex).toBe(1)
    expect(store.getState().pendingPlacement!.candidates).toBe(candidates)

    // Same value → no state churn.
    const before = store.getState().pendingPlacement
    store.getState().setPlacementHover(1)
    expect(store.getState().pendingPlacement).toBe(before)

    store.getState().setPlacementHover(null)
    expect(store.getState().pendingPlacement!.hoveredIndex).toBeNull()
  })
})

describe('re-entrant beginPlacement (placement pending → begin again)', () => {
  it('rolls back the previous pending panel and replaces the transaction (latest wins)', () => {
    const { store } = storeWithSeed(1.5, { x: 120, y: -40 })
    const firstCancelled = vi.fn()
    const secondCancelled = vi.fn()
    store.getState().beginPlacement('p2', 'terminal', firstCancelled)
    const zoomDuringFirst = store.getState().zoomLevel

    store.getState().beginPlacement('p3', 'editor', secondCancelled)

    // First transaction's orphan panel was rolled back immediately.
    expect(firstCancelled).toHaveBeenCalledTimes(1)
    expect(firstCancelled).toHaveBeenCalledWith('p2')
    expect(secondCancelled).not.toHaveBeenCalled()
    const pending = store.getState().pendingPlacement!
    expect(pending.panelId).toBe('p3')
    expect(pending.panelType).toBe('editor')

    // BUG?: the replacement transaction snapshots the CURRENT (already
    // zoomed-out) viewport rather than inheriting the first transaction's
    // snapshot, so the user's original viewport (zoom 1.5, offset 120/-40)
    // leaks: cancelling now restores the first placement's zoomed-out camera,
    // not where the user actually was before any placement started.
    expect(pending.prevZoom).toBe(zoomDuringFirst)
    expect(pending.prevZoom).not.toBe(1.5)
    store.getState().cancelPlacement()
    expect(store.getState().zoomLevel).toBe(zoomDuringFirst)
    expect(store.getState().zoomLevel).not.toBe(1.5)
    expect(secondCancelled).toHaveBeenCalledTimes(1)
  })

  it('re-triggering with the SAME panel id does not roll the panel back', () => {
    const { store } = storeWithSeed()
    const onCancelled = vi.fn()
    store.getState().beginPlacement('p2', 'terminal', onCancelled)

    store.getState().beginPlacement('p2', 'terminal', onCancelled)

    expect(onCancelled).not.toHaveBeenCalled()
    expect(store.getState().pendingPlacement!.panelId).toBe('p2')
    // The panel is still placeable exactly once.
    expect(store.getState().commitPlacement(0)).not.toBeNull()
    expect(nodeCount(store)).toBe(2)
  })
})
