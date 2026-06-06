import { describe, it, expect } from 'vitest'
import { enclosedMask, buildPocketMask } from './territoryPocketMask'

// Build a w×h field, defaulting every cell to `fill`.
function field(w: number, h: number, fill: number): Float32Array {
  const f = new Float32Array(w * h)
  f.fill(fill)
  return f
}

describe('enclosedMask', () => {
  const THR = 100
  const LOW = 0    // territory (below threshold)
  const HIGH = 200 // background (at/above threshold)

  it('returns null when the whole field is territory (no background)', () => {
    expect(enclosedMask(field(5, 5, LOW), 5, 5, THR)).toBeNull()
  })

  it('returns null when all background reaches the border', () => {
    expect(enclosedMask(field(5, 5, HIGH), 5, 5, THR)).toBeNull()
  })

  it('marks a background pocket walled off from the border by territory', () => {
    const w = 7, h = 7
    const f = field(w, h, HIGH) // border + center start as background
    const idx = (x: number, y: number) => y * w + x
    // Low "wall": perimeter of the inner 5×5 box (rows/cols 1 and 5).
    for (let i = 1; i <= 5; i++) {
      f[idx(1, i)] = LOW; f[idx(5, i)] = LOW
      f[idx(i, 1)] = LOW; f[idx(i, 5)] = LOW
    }
    const mask = enclosedMask(f, w, h, THR)
    expect(mask).not.toBeNull()
    // Center (enclosed background) is filled.
    expect(mask![idx(3, 3)]).toBe(255)
    // Border background reaches the edge → not filled.
    expect(mask![idx(0, 0)]).toBe(0)
    // The wall itself is territory (below thr) → never part of the mask.
    expect(mask![idx(1, 3)]).toBe(0)
  })
})

describe('buildPocketMask', () => {
  it('returns null for no groups', () => {
    expect(buildPocketMask([])).toBeNull()
  })

  it('returns null for a single isolated panel (nothing to enclose)', () => {
    expect(buildPocketMask([{ color: '#fff', rects: [{ x: 0, y: 0, w: 200, h: 200 }] }])).toBeNull()
  })

  it('detects an enclosed lake inside a ring of same-worktree panels', () => {
    // 8 panels around a large square hole: adjacent panels are near enough to
    // bridge into a connected loop, opposite panels are too far to bridge across
    // the centre, so the centre stays background and is enclosed.
    const S = 200      // panel size
    const R = 1300     // ring extent
    const mk = (x: number, y: number) => ({ x, y, w: S, h: S })
    const rects = [
      mk(0, 0), mk(R / 2, 0), mk(R, 0),
      mk(0, R / 2), mk(R, R / 2),
      mk(0, R), mk(R / 2, R), mk(R, R),
    ]
    const mask = buildPocketMask([{ color: '#fff', rects }])
    expect(mask).not.toBeNull()
    // Some cell is flagged as an enclosed pocket.
    expect(mask!.data.some((v) => v === 255)).toBe(true)
  })
})
