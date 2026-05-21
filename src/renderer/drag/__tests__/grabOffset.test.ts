import { describe, it, expect } from 'vitest'
import { dockTabGrabOffset } from '../grabOffset'

describe('dockTabGrabOffset (regression: main-window dock-tab ghost centers on cursor)', () => {
  it('preserves cursor offset from tab top-left when cursor is mid-tab', () => {
    const grab = dockTabGrabOffset({
      cursorClient: { x: 50, y: 10 },
      sourceRect: { left: 0, top: 0, width: 120, height: 30 },
      ghostSize: { width: 320, height: 200 },
    })
    expect(grab.x).toBeCloseTo(50, 0)
    expect(grab.y).toBeCloseTo(10, 0)
  })

  it('does NOT scale grab.y proportionally into the larger ghost height', () => {
    const grab = dockTabGrabOffset({
      cursorClient: { x: 60, y: 20 },
      sourceRect: { left: 0, top: 0, width: 120, height: 30 },
      ghostSize: { width: 320, height: 200 },
    })
    expect(grab.y).toBeLessThanOrEqual(30)
    expect(grab.y).toBeLessThan(132)
  })

  it('returns near (0, 0) when cursor is at the tab top-left corner', () => {
    const grab = dockTabGrabOffset({
      cursorClient: { x: 0, y: 0 },
      sourceRect: { left: 0, top: 0, width: 120, height: 30 },
      ghostSize: { width: 320, height: 200 },
    })
    expect(grab.x).toBeCloseTo(0, 0)
    expect(grab.y).toBeCloseTo(0, 0)
  })

  it('caps grab.y to roughly the source tab height regardless of ghost size', () => {
    const grab = dockTabGrabOffset({
      cursorClient: { x: 115, y: 28 },
      sourceRect: { left: 0, top: 0, width: 120, height: 30 },
      ghostSize: { width: 320, height: 200 },
    })
    expect(grab.y).toBeLessThanOrEqual(30)
  })

  it('handles non-zero sourceRect origin (tab not at viewport origin)', () => {
    const grab = dockTabGrabOffset({
      cursorClient: { x: 250, y: 110 },
      sourceRect: { left: 200, top: 100, width: 120, height: 30 },
      ghostSize: { width: 320, height: 200 },
    })
    expect(grab.x).toBeCloseTo(50, 0)
    expect(grab.y).toBeCloseTo(10, 0)
  })
})
