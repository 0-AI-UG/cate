import { describe, expect, it } from 'vitest'
import type { PanelRecord } from '@workspace/document/contract'
import { DRAWING_MARGIN, addStroke, drawingFrame, drawingStrokes, hitsStroke, strokesToJson, type Stroke } from './contract'

const pen = (points: number[], width = 2): Stroke => ({ kind: 'pen', points, color: '#f00', width, dashed: false, filled: false })

describe('addStroke', () => {
  it('starts a drawing around its first stroke', () => {
    const { strokes, frame, rect } = addStroke([], null, null, pen([100, 200, 150, 260]))
    const pad = 1 + DRAWING_MARGIN
    expect(rect.origin).toEqual({ x: 100 - pad, y: 200 - pad })
    expect(frame).toEqual({ width: 50 + 2 * pad, height: 60 + 2 * pad })
    expect(rect.size).toEqual(frame)
    // Points are in the drawing's own space.
    expect(strokes[0].points).toEqual([pad, pad, 50 + pad, 60 + pad])
  })

  it('grows to hold a stroke past its edge and keeps earlier strokes in place', () => {
    const first = addStroke([], null, null, pen([100, 100, 120, 120]))
    const second = addStroke(first.strokes, first.frame, first.rect, pen([50, 300, 60, 310]))
    // The first stroke's first point is still at canvas (100, 100).
    const p = second.strokes[0].points
    expect(second.rect.origin.x + p[0]).toBeCloseTo(100)
    expect(second.rect.origin.y + p[1]).toBeCloseTo(100)
    expect(second.rect.origin.x).toBeLessThan(first.rect.origin.x)
    expect(second.rect.size.height).toBeGreaterThan(first.rect.size.height)
  })

  it('maps a stroke into a drawing that was resized', () => {
    const first = addStroke([], null, null, pen([0, 0, 100, 100]))
    // Shown at twice its size.
    const rect = { origin: first.rect.origin, size: { width: first.frame.width * 2, height: first.frame.height * 2 } }
    const second = addStroke(first.strokes, first.frame, rect, pen([rect.origin.x + 20, rect.origin.y + 20, rect.origin.x + 40, rect.origin.y + 40]))
    expect(second.frame).toEqual(first.frame)
    expect(second.strokes[1].points).toEqual([10, 10, 20, 20])
    expect(second.strokes[1].width).toBe(1)
  })
})

describe('hitsStroke', () => {
  it('hits near the line and misses away from it', () => {
    const line = pen([0, 0, 100, 0])
    expect(hitsStroke(line, { x: 50, y: 4 }, 4)).toBe(true)
    expect(hitsStroke(line, { x: 50, y: 20 }, 4)).toBe(false)
  })

  it('hits inside a filled shape only', () => {
    const rect: Stroke = { kind: 'rect', points: [0, 0, 100, 100], color: '#f00', width: 2, dashed: false, filled: false }
    expect(hitsStroke(rect, { x: 50, y: 50 }, 4)).toBe(false)
    expect(hitsStroke({ ...rect, filled: true }, { x: 50, y: 50 }, 4)).toBe(true)
    expect(hitsStroke(rect, { x: 0, y: 50 }, 4)).toBe(true)
  })
})

describe('reading a record', () => {
  it('skips unreadable strokes and reads the frame', () => {
    const record: PanelRecord = {
      id: 'd', type: 'drawing', title: 'Drawing',
      fields: { strokes: [...(strokesToJson([pen([1, 2, 3, 4])]) as never[]), { kind: 'nope' }, { kind: 'pen', points: [1] }], frame: { width: 10, height: 20 } },
    }
    expect(drawingStrokes(record)).toHaveLength(1)
    expect(drawingFrame(record)).toEqual({ width: 10, height: 20 })
  })
})
