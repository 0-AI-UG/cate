// =============================================================================
// terminalCoordAdjust: decide whether the terminal's capture-phase pointer
// handler should rewrite clientX/clientY to cancel the canvas zoom.
//
// xterm.js measures cell sizes in DOM space but computes mouse offsets from
// getBoundingClientRect(), which IS affected by the canvas scale(zoom). On a
// zoomed canvas that mismatch makes text selection target the wrong cell, so
// TerminalView intercepts mouse events in the capture phase and divides the
// offset back into DOM space. That rewrite must be SKIPPED in three cases, or a
// middle/right-button drag-pan jumps at the start:
//
//  1. A canvas gesture (pan / edge-resize) already owns the pointer: the
//     shared `canvas-interacting` body class is set. Rewriting here feeds the
//     gesture a coordinate whose reference rect is itself moving.
//  2. A non-left press/release, or any move with a non-left button held. The
//     opening press runs before the canvas sets `canvas-interacting`, and
//     MouseEvent.button is normally 0 on follow-up moves even for a middle drag;
//     MouseEvent.buttons carries the held-button state. Leaving the whole gesture
//     raw prevents the pan origin and move coordinates from entering different
//     spaces even if the shared body class is temporarily absent.
//  3. The canvas isn't zoomed (effective ~= 1): there is nothing to cancel.
//
// Keeping this decision as a pure function lets the middle-click-pan regression
// be locked by a fast unit test (the interplay that produces the jump: native
// capture ordering, React synthetic events, pointer-events fallthrough: is not
// reproducible in jsdom, but the guard that prevents it is).
// =============================================================================

/** Epsilon around 1.0 below which the canvas counts as "not zoomed". */
const ZOOM_ADJUST_EPSILON = 0.001

/**
 * Whether a terminal pointer event at the given zoom should have its
 * clientX/clientY rewritten to cancel the canvas scale.
 *
 * @param type        DOM event type ("mousedown" | "mousemove" | "mouseup")
 * @param button      MouseEvent.button (0 = left, 1 = middle, 2 = right)
 * @param interacting Whether document.body carries the `canvas-interacting` class
 * @param effective   zoomLevel / renderScale: the residual scale on .xterm-screen
 * @param buttons     MouseEvent.buttons bitmask (1 = left, 2 = right, 4 = middle)
 */
export function shouldAdjustTerminalCoords(
  type: string,
  button: number,
  interacting: boolean,
  effective: number,
  buttons: number,
): boolean {
  // (1) a pan/resize gesture owns the pointer: leave every event raw.
  if (interacting) return false
  // (2) xterm only needs adjusted coordinates for its own left-button gesture.
  // Mousemove.button is normally 0 regardless of which button is held, so also
  // inspect the buttons bitmask to keep middle/right pan moves raw.
  if ((type === 'mousedown' || type === 'mouseup') && button !== 0) return false
  if (type === 'mousemove' && (buttons & ~1) !== 0) return false
  // (3) not zoomed: nothing to cancel.
  if (Math.abs(effective - 1.0) < ZOOM_ADJUST_EPSILON) return false
  return true
}
