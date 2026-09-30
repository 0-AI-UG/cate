import { describe, it, expect } from 'vitest'
import {
  boundingRect,
  canvasToView,
  CANVAS_GRID_SIZE,
  findNodeInDirection,
  findSharedBorders,
  rect,
  rectContains,
  rectsOverlap,
  snapResizeDelta,
  snapToGrid,
  viewToCanvas,
  type Box,
  type MovingEdges,
} from './geometry'
import { autoLayout, stackRects, tidyGridRects } from './arrange'

const NONE: MovingEdges = { left: false, right: false, top: false, bottom: false }

describe('snapToGrid', () => {
  it('rounds to the nearest grid intersection (default grid)', () => {
    expect(CANVAS_GRID_SIZE).toBe(20)
    expect(snapToGrid({ x: 11, y: 9 })).toEqual({ x: 20, y: 0 })
    expect(snapToGrid({ x: 250, y: 175 })).toEqual({ x: 260, y: 180 })
  })

  it('handles negative coordinates', () => {
    // x: round(-25/20)=-1 → -20; y: round(-31/20)=-2 → -40
    expect(snapToGrid({ x: -25, y: -31 })).toEqual({ x: -20, y: -40 })
  })
})

describe('snapResizeDelta', () => {
  const origin = { x: 100, y: 100 }
  const size = { width: 300, height: 200 } // right edge x=400, bottom edge y=300

  it('snaps the right edge, leaving the left edge fixed', () => {
    // right edge at 400 + 7 = 407 → nearest grid 400 → delta back to 0
    const d = snapResizeDelta({ ...NONE, right: true }, origin, size, { x: 7, y: 0 })
    expect(d).toEqual({ x: 0, y: 0 })
    // right edge 400 + 13 = 413 → 420 → dx = 20
    expect(snapResizeDelta({ ...NONE, right: true }, origin, size, { x: 13, y: 0 })).toEqual({ x: 20, y: 0 })
  })

  it('snaps the left edge to the grid (origin lands on a line)', () => {
    // left edge 100 + 7 = 107 → 100 → dx 0
    expect(snapResizeDelta({ ...NONE, left: true }, origin, size, { x: 7, y: 0 })).toEqual({ x: 0, y: 0 })
    // left edge 100 - 13 = 87 → 80 → dx -20
    expect(snapResizeDelta({ ...NONE, left: true }, origin, size, { x: -13, y: 0 })).toEqual({ x: -20, y: 0 })
  })

  it('snaps the bottom edge', () => {
    // bottom 300 + 11 = 311 → 320 → dy 20
    expect(snapResizeDelta({ ...NONE, bottom: true }, origin, size, { x: 0, y: 11 })).toEqual({ x: 0, y: 20 })
  })

  it('snaps the top edge', () => {
    // top 100 - 7 = 93 → 100 → dy 0
    expect(snapResizeDelta({ ...NONE, top: true }, origin, size, { x: 0, y: -7 })).toEqual({ x: 0, y: 0 })
  })

  it('snaps both axes independently for a corner (bottom-right)', () => {
    const d = snapResizeDelta({ ...NONE, right: true, bottom: true }, origin, size, { x: 13, y: 11 })
    expect(d).toEqual({ x: 20, y: 20 })
  })

  it('leaves a non-moving axis untouched', () => {
    // Only the right edge moves: dy passes through unchanged even if non-grid.
    const d = snapResizeDelta({ ...NONE, right: true }, origin, size, { x: 13, y: 37 })
    expect(d).toEqual({ x: 20, y: 37 })
  })

  it('respects a custom grid size', () => {
    // right edge 400 + 18 = 418, grid 50 → 400 → dx 0; +30 → 430 → 450 → dx 50
    expect(snapResizeDelta({ ...NONE, right: true }, origin, size, { x: 18, y: 0 }, 50)).toEqual({ x: 0, y: 0 })
    expect(snapResizeDelta({ ...NONE, right: true }, origin, size, { x: 30, y: 0 }, 50)).toEqual({ x: 50, y: 0 })
  })

  it('a zero delta still snaps a non-grid-aligned edge', () => {
    // A panel whose right edge sits off the grid (100 + 305 = 405). Snapping a
    // zero-length gesture — i.e. a bare click on the edge with no drag — would
    // still pull that edge onto the nearest grid line (405 → 400, dx -5). This
    // is why a resize gesture only snaps once it actually moved: an unguarded
    // snap on mouseup would resize a panel the user only clicked.
    const offGrid = { width: 305, height: 200 } // right edge x = 405
    expect(snapResizeDelta({ ...NONE, right: true }, origin, offGrid, { x: 0, y: 0 })).toEqual({ x: -5, y: 0 })
  })
})

const box = (id: string, x: number, y: number, w: number, h: number): Box => ({ id, rect: rect(x, y, w, h) })
const byId = (...boxes: Box[]) => Object.fromEntries(boxes.map((b) => [b.id, b]))

describe('rects', () => {
  it('touching edges do not overlap; any shared area does', () => {
    expect(rectsOverlap(rect(0, 0, 10, 10), rect(10, 0, 10, 10))).toBe(false)
    expect(rectsOverlap(rect(0, 0, 10, 10), rect(9, 9, 10, 10))).toBe(true)
  })

  it('contains with half a unit of tolerance', () => {
    expect(rectContains(rect(0, 0, 100, 100), rect(-0.4, 0, 100.4, 100))).toBe(true)
    expect(rectContains(rect(0, 0, 100, 100), rect(-1, 0, 50, 50))).toBe(false)
  })

  it('bounds a set of rects', () => {
    expect(boundingRect([])).toBeNull()
    expect(boundingRect([rect(0, 0, 10, 10), rect(20, -5, 5, 5)])).toEqual(rect(0, -5, 25, 15))
  })

  it('converts between canvas and view space, flooring a corrupt zoom', () => {
    const p = canvasToView({ x: 10, y: 20 }, 2, { x: 5, y: 5 })
    expect(p).toEqual({ x: 25, y: 45 })
    expect(viewToCanvas(p, 2, { x: 5, y: 5 })).toEqual({ x: 10, y: 20 })
    expect(viewToCanvas({ x: 1, y: 1 }, 0, { x: 0, y: 0 })).toEqual({ x: 100, y: 100 })
  })
})

describe('findSharedBorders', () => {
  it('finds neighbours whose opposite edge lines up and overlaps along it', () => {
    const nodes = byId(
      box('a', 0, 0, 100, 100),
      box('b', 101, 50, 100, 100), // left edge within tolerance of a's right edge
      box('c', 100, 200, 100, 100), // aligned but no vertical overlap
      box('d', 0, 100, 100, 50), // below a
    )
    expect(findSharedBorders('a', 'right', nodes)).toEqual([{ neighborId: 'b', neighborEdge: 'left' }])
    expect(findSharedBorders('a', 'bottom', nodes)).toEqual([{ neighborId: 'd', neighborEdge: 'top' }])
    expect(findSharedBorders('missing', 'left', nodes)).toEqual([])
  })
})

describe('findNodeInDirection', () => {
  const nodes = [box('a', 0, 0, 100, 100), box('right', 300, 20, 100, 100), box('below', 10, 300, 100, 100), box('diag', 300, 300, 100, 100)]
  it('picks the nearest node in the cone of the direction', () => {
    expect(findNodeInDirection(nodes, { x: 50, y: 50 }, 'right', 'a')?.id).toBe('right')
    expect(findNodeInDirection(nodes, { x: 50, y: 50 }, 'down', 'a')?.id).toBe('below')
    expect(findNodeInDirection(nodes, { x: 50, y: 50 }, 'left', 'a')).toBeNull()
  })
})

describe('arrangement', () => {
  it('autoLayout lays nodes out in creation order on a uniform grid', () => {
    const out = autoLayout([box('a', 500, 500, 10, 10), box('b', 0, 0, 10, 10), box('c', 9, 9, 10, 10)], { width: 1600, height: 1000 })
    expect(out.map((r) => r.nodeId)).toEqual(['a', 'b', 'c'])
    const sizes = new Set(out.map((r) => `${r.rect.size.width}x${r.rect.size.height}`))
    expect(sizes.size).toBe(1)
    expect(out[0].rect.origin).toEqual({ x: 6, y: 6 })
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) expect(rectsOverlap(out[i].rect, out[j].rect)).toBe(false)
    }
    expect(autoLayout([], { width: 100, height: 100 })).toEqual([])
  })

  it('stackRects lines nodes up from the top-left of the group, keeping sizes', () => {
    const out = stackRects([box('b', 400, 50, 200, 100), box('a', 100, 80, 100, 300)], 'row', 10)
    expect(out).toEqual([
      { nodeId: 'a', rect: rect(100, 50, 100, 300) },
      { nodeId: 'b', rect: rect(210, 50, 200, 100) },
    ])
    expect(stackRects([box('a', 0, 0, 1, 1)], 'column')).toEqual([])
  })

  it('tidyGridRects fills a near-square grid in reading order with the largest cell', () => {
    const out = tidyGridRects([
      box('c', 0, 500, 100, 100),
      box('a', 0, 0, 200, 100),
      box('b', 300, 0, 100, 150),
    ], 10)
    expect(out).toEqual([
      { nodeId: 'a', rect: rect(0, 0, 200, 100) },
      { nodeId: 'b', rect: rect(210, 0, 100, 150) },
      { nodeId: 'c', rect: rect(0, 160, 100, 100) },
    ])
  })
})
