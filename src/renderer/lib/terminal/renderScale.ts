// =============================================================================
// renderScale — pick the resolution xterm rasterizes its glyph atlas at for a
// given canvas zoom. Pure so the snap boundaries can be unit-tested without
// dragging in xterm (whose WebGL addon needs a browser global at import time).
// =============================================================================

// Discrete render-scale steps. We snap canvas zoom to one of these so a
// continuous pinch only triggers a small number of expensive atlas rebuilds.
// Capped at 2.5× — beyond that, atlas memory grows without perceptible gain.
//
// 0.25 spacing, not 0.5: the residual CSS rescale is zoom/renderScale, so the
// worst case sits halfway between two steps. With [1.0, 1.5, …] that put the
// blurriest point at exactly 125% (a 25% upscale) — and 125% was also a tie
// (|1.25-1.0| === |1.25-1.5|), so a hair past it the scale jumped a full 1.5×
// at once, visibly resizing the terminal. Halving the spacing halves both the
// worst-case blur and the size step, and lands 125%/175% exactly on a step
// where the rescale is 1:1.
export const RENDER_SCALE_STEPS: number[] = [1.0, 1.25, 1.5, 1.75, 2.0, 2.5]

/**
 * Snap a canvas zoom level to the nearest render-scale step.
 *
 * Zoom-out returns 1.0: the atlas is already being downsampled, so rasterizing
 * it smaller buys nothing back.
 */
export function snapRenderScale(zoom: number): number {
  if (zoom <= 1.0) return 1.0
  const top = RENDER_SCALE_STEPS[RENDER_SCALE_STEPS.length - 1]
  if (zoom > top) return top

  let best = RENDER_SCALE_STEPS[0]
  let bestDist = Math.abs(zoom - best)
  for (const step of RENDER_SCALE_STEPS) {
    const d = Math.abs(zoom - step)
    if (d < bestDist) {
      best = step
      bestDist = d
    }
  }
  return best
}
