import { describe, expect, it } from 'vitest'
import type { Rect } from '../../shared/types'
import { panelConnectionMidpoint, panelConnectionPath } from './panelConnectionGeometry'

const rect = (x: number, y: number, width = 100, height = 80): Rect => ({
  origin: { x, y },
  size: { width, height },
})

describe('panelConnectionPath', () => {
  it('connects horizontal rectangles at their facing edges with a gap', () => {
    const path = panelConnectionPath(rect(0, 0), rect(300, 0))!
    expect(path).toMatch(/^M 107 40 C /)
    expect(path).toMatch(/, 293 40$/)
    expect(path.match(/ C /g)).toHaveLength(4)
  })

  it('connects vertical rectangles at their facing edges', () => {
    const path = panelConnectionPath(rect(0, 0), rect(0, 240))
    expect(path).toMatch(/^M 50 87 C /)
    expect(path).toMatch(/, 50 233$/)
  })

  it('anchors diagonal connections at the middle of a side', () => {
    const path = panelConnectionPath(rect(0, 0), rect(220, 160))
    expect(path).toMatch(/^M 107 40 C /)
    expect(path).toMatch(/, 213 200$/)
  })

  it('does not invent a direction for coincident rectangles', () => {
    expect(panelConnectionPath(rect(10, 20), rect(10, 20))).toBeNull()
  })

  it('keeps a declared connection attached to its selected ports', () => {
    const path = panelConnectionPath(rect(0, 0), rect(300, 0), 'bottom', 'top')
    expect(path).toMatch(/^M 50 92 C /)
    expect(path).toMatch(/, 350 -12$/)
  })

  it('positions horizontal UI at the midpoint of the rendered curve', () => {
    expect(panelConnectionMidpoint(rect(0, 0), rect(300, 0))).toEqual({ x: 200, y: 40 })
  })

  it('routes the curve through a moved relationship waypoint', () => {
    const waypoint = { x: 180, y: 140 }
    expect(panelConnectionMidpoint(rect(0, 0), rect(300, 0), undefined, undefined, waypoint)).toEqual(waypoint)
    expect(panelConnectionPath(rect(0, 0), rect(300, 0), undefined, undefined, waypoint))
      .toContain(', 180 140 C ')
  })
})
