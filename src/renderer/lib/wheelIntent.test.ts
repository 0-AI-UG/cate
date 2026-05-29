import { describe, it, expect } from 'vitest'
import { isMouseWheel, type WheelLike } from './wheelIntent'

const wheel = (over: Partial<WheelLike>): WheelLike => ({
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  ctrlKey: false,
  ...over,
})

describe('isMouseWheel', () => {
  it('treats vertical 120-multiple notches as a mouse wheel', () => {
    expect(isMouseWheel(wheel({ deltaY: -40, wheelDeltaY: 120 }))).toBe(true)
    expect(isMouseWheel(wheel({ deltaY: 40, wheelDeltaY: -120 }))).toBe(true)
    expect(isMouseWheel(wheel({ deltaY: -80, wheelDeltaY: 240 }))).toBe(true)
  })

  it('treats fractional / non-120 deltas as a trackpad', () => {
    expect(isMouseWheel(wheel({ deltaY: 3, wheelDeltaY: 9 }))).toBe(false)
    expect(isMouseWheel(wheel({ deltaY: -7, wheelDeltaY: 21 }))).toBe(false)
  })

  it('treats a horizontal component as a trackpad even at a 120 multiple', () => {
    expect(isMouseWheel(wheel({ deltaX: 2, deltaY: -40, wheelDeltaY: 120 }))).toBe(false)
  })

  it('never classifies a pinch (ctrlKey) as a mouse wheel', () => {
    expect(isMouseWheel(wheel({ ctrlKey: true, deltaY: -40, wheelDeltaY: 120 }))).toBe(false)
  })

  it('falls back to deltaMode when wheelDeltaY is absent', () => {
    expect(isMouseWheel(wheel({ deltaY: -3, deltaMode: 1 }))).toBe(true) // line mode = wheel
    expect(isMouseWheel(wheel({ deltaY: -3, deltaMode: 0 }))).toBe(false) // pixel mode = trackpad
  })
})
