// =============================================================================
// mouse — small pointer-event predicates shared across the UI.
// =============================================================================

/**
 * True for a middle-button (button 1) mouse/pointer/aux event.
 *
 * `auxclick` fires for BOTH the middle (1) and right (2) buttons, so callers
 * that close-on-middle-click must guard with this to avoid right-click — which
 * should keep opening the context menu — also triggering the close.
 */
export function isMiddleClick(e: { button: number }): boolean {
  return e.button === 1
}
