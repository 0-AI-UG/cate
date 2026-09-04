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
      'M 107 40 C 203 40, 197 40, 293 40',
    )
  })

  it('connects vertical rectangles at their facing edges', () => {
    const path = panelConnectionPath(rect(0, 0), rect(0, 240))
    expect(path).toMatch(/^M 50 87 C /)
    expect(path).toMatch(/, 50 233$/)
  })

  it('does not invent a direction for coincident rectangles', () => {
    expect(panelConnectionPath(rect(10, 20), rect(10, 20))).toBeNull()
  })
})
