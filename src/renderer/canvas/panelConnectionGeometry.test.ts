import { describe, expect, it } from 'vitest'
import type { Rect } from '../../shared/types'
import { panelConnectionPath } from './panelConnectionGeometry'

const rect = (x: number, y: number, width = 100, height = 80): Rect => ({
  origin: { x, y },
  size: { width, height },
})

describe('panelConnectionPath', () => {
  it('connects horizontal rectangles at their facing edges with a gap', () => {
    expect(panelConnectionPath(rect(0, 0), rect(300, 0))).toBe(
      'M 107 40 C 153.5 40, 246.5 40, 293 40',
    )
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
})
