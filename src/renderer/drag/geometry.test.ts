import { describe, it, expect } from 'vitest'
import {
  cursorToCanvasOrigin,
  ghostScreenRect,
  normalizeGrabOffset,
} from './geometry'

// Helper: build a fake DOMRect at the given top-left with given size.
function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON() {
      return {}
    },
  } as DOMRect
}

describe('cursorToCanvasOrigin', () => {
  it('returns the cursor-canvas-space minus grab at zoom=1, zero offset', () => {
    const r = rect(0, 0, 1000, 1000)
    const origin = cursorToCanvasOrigin(
      { client: { x: 300, y: 200 } },
      r,
      1,
      { x: 0, y: 0 },
      { x: 50, y: 25 },
    )
    expect(origin).toEqual({ x: 250, y: 175 })
  })

  it('localizes the cursor by subtracting the container rect', () => {
    const r = rect(100, 80, 1000, 1000)
    const origin = cursorToCanvasOrigin(
      { client: { x: 300, y: 200 } },
      r,
      1,
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    )
    expect(origin).toEqual({ x: 200, y: 120 })
  })

  it('handles zoom=2 with nonzero viewport offset', () => {
    const r = rect(10, 20, 1000, 1000)
    // localView = (300 - 10, 200 - 20) = (290, 180)
    // cursorCanvas = ((290 - 30) / 2, (180 - 40) / 2) = (130, 70)
    // origin = cursorCanvas - grab = (130 - 10, 70 - 5) = (120, 65)
    const origin = cursorToCanvasOrigin(
      { client: { x: 300, y: 200 } },
      r,
      2,
      { x: 30, y: 40 },
      { x: 10, y: 5 },
    )
    expect(origin.x).toBeCloseTo(120)
    expect(origin.y).toBeCloseTo(65)
  })

  it('handles zoom=0.5 with nonzero viewport offset', () => {
    const r = rect(0, 0, 1000, 1000)
    // localView = (300, 200)
    // cursorCanvas = ((300 - 100) / 0.5, (200 - 50) / 0.5) = (400, 300)
    // origin = (400 - 20, 300 - 10) = (380, 290)
    const origin = cursorToCanvasOrigin(
      { client: { x: 300, y: 200 } },
      r,
      0.5,
      { x: 100, y: 50 },
      { x: 20, y: 10 },
    )
    expect(origin.x).toBeCloseTo(380)
    expect(origin.y).toBeCloseTo(290)
  })

  it('round-trips with ghostScreenRect at varied zoom', () => {
    // For zoom=1, no viewport offset, container at (0,0):
    // The ghost top-left in screen px should equal the origin (canvas-space) since
    // canvas-space == screen-space here.
    for (const zoom of [0.5, 1, 2]) {
      const r = rect(0, 0, 2000, 2000)
      const cursor = { x: 600, y: 400 }
      const grab = { x: 40, y: 30 }
      const origin = cursorToCanvasOrigin(
        { client: cursor },
        r,
        zoom,
        { x: 0, y: 0 },
        grab,
      )
      const ghost = ghostScreenRect(cursor, grab, { width: 200, height: 100 }, zoom)
      // Ghost top-left in screen px should equal origin * zoom (since offset = 0).
      expect(ghost.left).toBeCloseTo(origin.x * zoom)
      expect(ghost.top).toBeCloseTo(origin.y * zoom)
    }
  })
})

describe('ghostScreenRect', () => {
  it('places the cursor at the grab point inside the ghost (zoom=1)', () => {
    const cursor = { x: 500, y: 300 }
    const grab = { x: 40, y: 25 }
    const r = ghostScreenRect(cursor, grab, { width: 320, height: 200 }, 1)
    expect(cursor.x).toBe(r.left + grab.x * 1)
    expect(cursor.y).toBe(r.top + grab.y * 1)
    expect(r.width).toBe(320)
    expect(r.height).toBe(200)
  })

  it('scales size by zoom and keeps cursor at scaled grab point (zoom=2)', () => {
    const cursor = { x: 500, y: 300 }
    const grab = { x: 40, y: 25 }
    const r = ghostScreenRect(cursor, grab, { width: 320, height: 200 }, 2)
    expect(cursor.x).toBe(r.left + grab.x * 2)
    expect(cursor.y).toBe(r.top + grab.y * 2)
    expect(r.width).toBe(640)
    expect(r.height).toBe(400)
  })

  it('scales size by zoom (zoom=0.5)', () => {
    const r = ghostScreenRect({ x: 500, y: 300 }, { x: 0, y: 0 }, { width: 320, height: 200 }, 0.5)
    expect(r.width).toBe(160)
    expect(r.height).toBe(100)
  })
})

describe('normalizeGrabOffset', () => {
  it('returns delta from source rect top-left at zoom=1', () => {
    const r = rect(100, 50, 400, 300)
    const grab = normalizeGrabOffset({ x: 180, y: 110 }, r, 1)
    expect(grab).toEqual({ x: 80, y: 60 })
  })

  it('divides by source zoom (zoom=2 → grab is half the screen-px delta)', () => {
    const r = rect(0, 0, 400, 300)
    const grab = normalizeGrabOffset({ x: 100, y: 60 }, r, 2)
    expect(grab.x).toBeCloseTo(50)
    expect(grab.y).toBeCloseTo(30)
  })

  it('divides by source zoom (zoom=0.5 → grab is double the screen-px delta)', () => {
    const r = rect(0, 0, 400, 300)
    const grab = normalizeGrabOffset({ x: 100, y: 60 }, r, 0.5)
    expect(grab.x).toBeCloseTo(200)
    expect(grab.y).toBeCloseTo(120)
  })

  it('floors non-finite or near-zero zoom to 1', () => {
    const r = rect(0, 0, 400, 300)
    const grabNaN = normalizeGrabOffset({ x: 100, y: 60 }, r, Number.NaN)
    expect(grabNaN).toEqual({ x: 100, y: 60 })
    const grabZero = normalizeGrabOffset({ x: 100, y: 60 }, r, 0)
    expect(grabZero).toEqual({ x: 100, y: 60 })
    const grabNeg = normalizeGrabOffset({ x: 100, y: 60 }, r, -2)
    expect(grabNeg).toEqual({ x: 100, y: 60 })
  })
})
