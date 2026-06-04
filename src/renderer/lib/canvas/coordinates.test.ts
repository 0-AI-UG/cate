import { describe, it, expect } from 'vitest'
import { canvasToView, viewToCanvas, viewFrame } from './coordinates'

describe('canvasToView', () => {
  it('applies zoom and offset', () => {
    expect(canvasToView({ x: 10, y: 20 }, 2, { x: 5, y: 7 })).toEqual({
      x: 25,
      y: 47,
    })
  })

  it('is the identity at zoom=1 with zero offset', () => {
    expect(canvasToView({ x: -3, y: 4 }, 1, { x: 0, y: 0 })).toEqual({
      x: -3,
      y: 4,
    })
  })
})

describe('viewToCanvas', () => {
  it('inverts canvasToView', () => {
    const zoom = 1.75
    const offset = { x: 12, y: -8 }
    const canvasPt = { x: 42, y: -17 }
    const view = canvasToView(canvasPt, zoom, offset)
    const round = viewToCanvas(view, zoom, offset)
    expect(round.x).toBeCloseTo(canvasPt.x)
    expect(round.y).toBeCloseTo(canvasPt.y)
  })

  it('clamps non-finite zoom to 0.01 to avoid NaN propagation', () => {
    const r = viewToCanvas({ x: 1, y: 1 }, Number.NaN, { x: 0, y: 0 })
    expect(Number.isFinite(r.x)).toBe(true)
    expect(Number.isFinite(r.y)).toBe(true)
    expect(r).toEqual({ x: 100, y: 100 })
  })

  it('clamps zero or negative zoom to 0.01', () => {
    expect(viewToCanvas({ x: 2, y: 2 }, 0, { x: 0, y: 0 })).toEqual({
      x: 200,
      y: 200,
    })
    expect(viewToCanvas({ x: 2, y: 2 }, -5, { x: 0, y: 0 })).toEqual({
      x: 200,
      y: 200,
    })
  })

  it('subtracts offset before dividing by zoom', () => {
    expect(viewToCanvas({ x: 25, y: 47 }, 2, { x: 5, y: 7 })).toEqual({
      x: 10,
      y: 20,
    })
  })
})

describe('viewFrame', () => {
  it('returns view-space origin and zoom-scaled size', () => {
    const frame = viewFrame(
      { origin: { x: 10, y: 20 }, size: { width: 100, height: 50 } },
      2,
      { x: 5, y: 7 },
    )
    expect(frame).toEqual({ x: 25, y: 47, width: 200, height: 100 })
  })

  it('matches canvasToView for the origin', () => {
    const node = { origin: { x: 3, y: 4 }, size: { width: 10, height: 10 } }
    const zoom = 0.5
    const offset = { x: 1, y: 2 }
    const view = canvasToView(node.origin, zoom, offset)
    const frame = viewFrame(node, zoom, offset)
    expect(frame.x).toBe(view.x)
    expect(frame.y).toBe(view.y)
    expect(frame.width).toBe(5)
    expect(frame.height).toBe(5)
  })
})
