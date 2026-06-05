// =============================================================================
// Per-instance mutable context shared across canvas-store slices.
//
// A few things must live outside zustand state (high-frequency, non-reactive)
// yet be shared between slices: the requestAnimationFrame handles for the
// zoom/pan tweens, and the latest pointer position used to anchor ghost
// placement. The factory creates one ctx per store instance and threads it into
// every slice creator, so each store keeps its own isolated animation/pointer
// bookkeeping.
// =============================================================================

import type { Point } from '../../../shared/types'

export interface CanvasStoreCtx {
  /** rAF handle for the in-flight zoom tween (0 when idle). */
  activeZoomAnimationRafId: number
  /** rAF handle for the in-flight viewport-pan tween (0 when idle). */
  activeOffsetAnimationRafId: number
  /** Destination the pan tween is easing toward; tracking it (rather than the
   *  mid-flight offset) lets rapid Shift+Arrow / Cmd+Arrow presses stack
   *  smoothly instead of lagging behind the keystrokes. */
  offsetAnimTarget: Point | null
  /** Latest canvas-space pointer position (for anchoring ghost recommendations
   *  to where the mouse is hovering). Kept off zustand state so high-frequency
   *  mousemove updates never trigger re-renders. */
  lastPointerCanvasPos: Point | null
  cancelZoomAnim: () => void
  cancelOffsetAnim: () => void
}

export function createCanvasStoreCtx(): CanvasStoreCtx {
  const ctx: CanvasStoreCtx = {
    activeZoomAnimationRafId: 0,
    activeOffsetAnimationRafId: 0,
    offsetAnimTarget: null,
    lastPointerCanvasPos: null,
    cancelZoomAnim() {
      if (ctx.activeZoomAnimationRafId) {
        cancelAnimationFrame(ctx.activeZoomAnimationRafId)
        ctx.activeZoomAnimationRafId = 0
      }
    },
    cancelOffsetAnim() {
      if (ctx.activeOffsetAnimationRafId) {
        cancelAnimationFrame(ctx.activeOffsetAnimationRafId)
        ctx.activeOffsetAnimationRafId = 0
      }
      ctx.offsetAnimTarget = null
    },
  }
  return ctx
}
