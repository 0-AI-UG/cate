import { describe, it, expect } from 'vitest'
import { computePlacement, type Rect } from './cateControlLayout'

const GAP = 40

describe('computePlacement', () => {
  const ref: Rect = { x: 100, y: 100, width: 200, height: 150 }
  const size = { width: 300, height: 200 }

  it('places to the right of the reference with a gap', () => {
    const r = computePlacement({
      size,
      relativeTo: ref,
      position: 'right',
      occupied: [],
      viewportCenter: { x: 0, y: 0 },
    })
    expect(r).toEqual({ x: 100 + 200 + GAP, y: 100, width: 300, height: 200 })
  })

  it('places to the left of the reference with a gap', () => {
    const r = computePlacement({ size, relativeTo: ref, position: 'left', occupied: [], viewportCenter: { x: 0, y: 0 } })
    expect(r).toEqual({ x: 100 - GAP - 300, y: 100, width: 300, height: 200 })
  })

  it('places below the reference with a gap', () => {
    const r = computePlacement({ size, relativeTo: ref, position: 'below', occupied: [], viewportCenter: { x: 0, y: 0 } })
    expect(r).toEqual({ x: 100, y: 100 + 150 + GAP, width: 300, height: 200 })
  })

  it('auto centers on the viewport center when there is no reference', () => {
    const r = computePlacement({ size, occupied: [], viewportCenter: { x: 500, y: 400 } })
    expect(r).toEqual({ x: 500 - 150, y: 400 - 100, width: 300, height: 200 })
  })

  it('auto nudges right to avoid overlap with an occupied rect', () => {
    const occupied: Rect[] = [{ x: 350, y: 300, width: 300, height: 200 }]
    const r = computePlacement({ size, occupied, viewportCenter: { x: 500, y: 400 } })
    // candidate at {350,300} overlaps -> shifted right by width+gap
    expect(r.x).toBe(350 + 300 + GAP)
    expect(r.y).toBe(300)
  })
})
