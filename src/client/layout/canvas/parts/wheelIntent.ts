// Tells a physical mouse wheel from a trackpad gesture. The canvas zooms on a
// mouse wheel and pans on a two-finger scroll, and both arrive as `wheel`
// events, so the deltas are all there is to go on.

// Minimal shape so this stays testable without a DOM WheelEvent.
export interface WheelLike {
  deltaX: number
  deltaY: number
  deltaMode: number
  ctrlKey: boolean
  /** Chromium only: wheel notches arrive as multiples of 120. */
  wheelDeltaY?: number
}

/** True when the event almost certainly came from a mouse wheel. A trackpad
 *  pinch carries `ctrlKey` and never counts. Trackpads emit pixel deltas that
 *  are not 120-aligned and usually carry a horizontal component. */
export function isMouseWheel(e: WheelLike): boolean {
  if (e.ctrlKey) return false
  const wd = e.wheelDeltaY
  if (typeof wd === 'number' && wd !== 0) {
    return e.deltaX === 0 && Math.abs(wd) % 120 === 0
  }
  // Without wheelDeltaY, line/page granularity only comes from a wheel.
  return e.deltaMode !== 0
}
