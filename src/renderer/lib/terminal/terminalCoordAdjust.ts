// =============================================================================
// terminalCoordAdjust — decide whether the terminal's capture-phase pointer
// handler should rewrite clientX/clientY to cancel the canvas zoom.
//
// xterm.js measures cell sizes in DOM space but computes mouse offsets from
// getBoundingClientRect(), which IS affected by the canvas scale(zoom). On a
// zoomed canvas that mismatch makes text selection target the wrong cell, so
// TerminalPanel intercepts mouse events in the capture phase and divides the
// offset back into DOM space. That rewrite must be SKIPPED in three cases, or a
// middle/right-button drag-pan jumps at the start:
//
//  1. A canvas gesture (pan / edge-resize) already owns the pointer — the
//     shared `canvas-interacting` body class is set. Rewriting here feeds the
//     gesture a coordinate whose reference rect is itself moving.
//  2. The OPENING press of a pan: a non-left mousedown. This capture handler
//     runs before the canvas sets `canvas-interacting`, so case 1 can't catch
//     it. If the mousedown were rewritten, the pan's start point would live in
//     adjusted space while every follow-up move stays raw, so the first delta
//     would be (raw - adjusted): a camera jump proportional to zoom. xterm only
//     needs adjusted coords for left-button selection, which a pan isn't.
//  3. The canvas isn't zoomed (effective ~= 1) — there is nothing to cancel.
//
// Keeping this decision as a pure function lets the middle-click-pan regression
// be locked by a fast unit test (the interplay that produces the jump — native
// capture ordering, React synthetic events, pointer-events fallthrough — is not
// reproducible in jsdom, but the guard that prevents it is).
// =============================================================================

/** Epsilon around 1.0 below which the canvas counts as "not zoomed". */
export const ZOOM_ADJUST_EPSILON = 0.001

/**
 * Whether a terminal pointer event at the given zoom should have its
 * clientX/clientY rewritten to cancel the canvas scale.
 *
 * @param type        DOM event type ("mousedown" | "mousemove" | "mouseup")
 * @param button      MouseEvent.button (0 = left, 1 = middle, 2 = right)
 * @param interacting Whether document.body carries the `canvas-interacting` class
 * @param effective   zoomLevel / renderScale — the residual scale on .xterm-screen
 */
export function shouldAdjustTerminalCoords(
  type: string,
  button: number,
  interacting: boolean,
  effective: number,
): boolean {
  // (1) a pan/resize gesture owns the pointer — leave every event raw.
  if (interacting) return false
  // (2) the opening press of a middle/right pan — leave it raw so lastPanPos is
  //     recorded in the same space as the follow-up moves (no first-delta jump).
  if (type === 'mousedown' && button !== 0) return false
  // (3) not zoomed — nothing to cancel.
  if (Math.abs(effective - 1.0) < ZOOM_ADJUST_EPSILON) return false
  return true
}
