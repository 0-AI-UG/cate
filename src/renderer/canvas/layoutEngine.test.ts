import { describe, it, expect } from 'vitest'
import { snapToGrid, snapResizeDelta, CANVAS_GRID_SIZE } from './layoutEngine'
import type { MovingEdges } from './layoutEngine'

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
    // is exactly why useNodeResize defers grid snapping to a gesture that
    // actually moved: an unguarded snap on mouseup would resize a panel the user
    // only clicked. See useNodeResize.gesture.test.tsx ('bare click is a no-op').
    const offGrid = { width: 305, height: 200 } // right edge x = 405
    expect(snapResizeDelta({ ...NONE, right: true }, origin, offGrid, { x: 0, y: 0 })).toEqual({ x: -5, y: 0 })
  })
})
