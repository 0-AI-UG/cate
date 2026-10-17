// Client features (architecture 12.2). The list is closed: adding one is a
// protocol minor version, and an unknown feature in `hello` is ignored.

export const CLIENT_FEATURES = [
  'webview',
  'pageDriver',
  'passkeys',
  'windows',
  'canvas',
  'fileDrop',
  'osNotifications',
  'screenCapture',
  'clipboard',
  'camera',
] as const

export type ClientFeature = (typeof CLIENT_FEATURES)[number]

const FEATURE_SET: ReadonlySet<string> = new Set(CLIENT_FEATURES)

export function isClientFeature(value: unknown): value is ClientFeature {
  return typeof value === 'string' && FEATURE_SET.has(value)
}

/** Keeps the known features of a peer's list, dropping unknown ones and duplicates. */
export function knownFeatures(values: readonly unknown[] | undefined): ClientFeature[] {
  if (!Array.isArray(values)) return []
  return [...new Set(values.filter(isClientFeature))]
}
