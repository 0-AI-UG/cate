// =============================================================================
// Native app catalog — the small set of one-click bundle-id choices offered by
// the nativeApp panel's launcher, plus the title derivation shared with
// appStore's createNativeApp/setPanelNativeAppBundleId (so a panel opened from
// the launcher and one restored from a saved bundleId get the same title).
// =============================================================================

export interface KnownNativeApp {
  bundleId: string
  label: string
}

export const KNOWN_NATIVE_APPS: KnownNativeApp[] = [
  { bundleId: 'com.apple.Safari', label: 'Safari' },
  { bundleId: 'com.apple.TextEdit', label: 'TextEdit' },
  { bundleId: 'com.apple.Notes', label: 'Notes' },
  { bundleId: 'com.apple.calculator', label: 'Calculator' },
]

/** Display label for a bundle id: the known app's friendly name, or the raw
 *  bundle id for a free-typed one. */
export function nativeAppLabelFor(bundleId: string): string {
  return KNOWN_NATIVE_APPS.find((a) => a.bundleId === bundleId)?.label ?? bundleId
}
