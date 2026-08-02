import { describe, it, expect } from 'vitest'
import { snapRenderScale, RENDER_SCALE_STEPS } from './renderScale'

// The residual CSS rescale applied to xterm's pre-rasterized glyph atlas is
// zoom / renderScale. It is 1:1 (crisp) only when zoom lands on a step, so what
// matters is the worst case between steps.
const residual = (zoom: number): number => zoom / snapRenderScale(zoom)

describe('snapRenderScale', () => {
  it('is exact on every step', () => {
    for (const zoom of RENDER_SCALE_STEPS) {
      expect(residual(zoom)).toBeCloseTo(1, 10)
    }
  })

  it('does not jump a full step at 125% (the reported blur/resize boundary)', () => {
    // Regression: with steps [1.0, 1.5, …], 1.25 was a tie that resolved to 1.0
    // (a 25% upscale — the blurriest point in the range) and 1.2501 jumped
    // straight to 1.5, swapping fontSize by 1.5× in one frame and visibly
    // resizing the terminal. 1.25 must now be its own step.
    expect(snapRenderScale(1.25)).toBe(1.25)
    expect(snapRenderScale(1.2501)).toBe(1.25)
    expect(snapRenderScale(1.24)).toBe(1.25)
  })

  it('never lets two adjacent steps differ by more than 1.25×', () => {
    // Bounds how far fontSize swings in a single step crossing — that swing is
    // what the measured cellCorrection in TerminalPanel has to absorb.
    for (let i = 1; i < RENDER_SCALE_STEPS.length; i++) {
      expect(RENDER_SCALE_STEPS[i] / RENDER_SCALE_STEPS[i - 1]).toBeLessThanOrEqual(1.25)
    }
  })

  it('keeps the residual rescale under 12.5% across the zoomed-in range', () => {
    for (let zoom = 1.0; zoom <= 2.0; zoom += 0.01) {
      expect(Math.abs(residual(zoom) - 1)).toBeLessThan(0.125)
    }
  })

  it('clamps below 1 and above the top step', () => {
    expect(snapRenderScale(0.5)).toBe(1.0)
    expect(snapRenderScale(1.0)).toBe(1.0)
    expect(snapRenderScale(3.0)).toBe(2.5)
  })
})
