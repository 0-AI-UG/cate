// =============================================================================
// Pure OS-notification gating decision. No imports — safe to unit-test.
// =============================================================================

/**
 * Returns true iff an OS notification should be dispatched given the current
 * notification settings and renderer-window focus state.
 *
 * Rules:
 *   - notificationsEnabled=false → never send.
 *   - notifyOnlyWhenUnfocused=true AND windowFocused=true → suppress (the user
 *     is already looking at the app).
 *   - Otherwise → send.
 */
export function shouldSendNotification(
  settings: { notificationsEnabled: boolean; notifyOnlyWhenUnfocused: boolean },
  windowFocused: boolean,
): boolean {
  if (!settings.notificationsEnabled) return false
  if (settings.notifyOnlyWhenUnfocused && windowFocused) return false
  return true
}
