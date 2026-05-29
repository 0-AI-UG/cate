// =============================================================================
// wheelIntent — classify a wheel event as a physical mouse wheel vs a trackpad
// gesture. The canvas maps a physical mouse wheel → zoom (Miro-style) while
// keeping a trackpad two-finger scroll → pan, and both arrive as `wheel`
// events, so we have to tell them apart from the deltas alone.
// =============================================================================

// Minimal shape so this stays unit-testable without a real DOM WheelEvent.
export interface WheelLike {
  deltaX: number
  deltaY: number
  deltaMode: number
  ctrlKey: boolean
  // Chromium-only, non-standard: physical wheel notches arrive as multiples of
  // 120. Undefined on engines that don't implement it.
  wheelDeltaY?: number
}

/**
 * True when a wheel event almost certainly came from a physical mouse wheel
 * (not a trackpad two-finger scroll or pinch).
 *
 * We run inside Electron/Chromium, where `WheelEvent.wheelDeltaY` is always
 * present and reports physical wheel notches as nonzero, vertical-only
 * multiples of 120. Trackpads emit pixel-precise deltas that are not
 * 120-aligned and usually carry a small horizontal component. A trackpad pinch
 * carries `ctrlKey` and is never a mouse wheel.
 */
export function isMouseWheel(e: WheelLike): boolean {
  // Pinch-to-zoom is delivered as a wheel with ctrlKey set — always trackpad.
  if (e.ctrlKey) return false
  const wd = e.wheelDeltaY
  if (typeof wd === 'number' && wd !== 0) {
    // Mouse notches are vertical-only multiples of 120; trackpads aren't.
    return e.deltaX === 0 && Math.abs(wd) % 120 === 0
  }
  // Engines without wheelDeltaY: line/page granularity only comes from a wheel.
  return e.deltaMode !== 0
}
