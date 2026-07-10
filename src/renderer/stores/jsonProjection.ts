// =============================================================================
// JSON Projection helpers — shared by stores that project a JSON file exposed
// through the preload electronAPI (settingsStore, uiStateStore). Each store
// hand-rolled the same window.electronAPI accessor and the same
// merge-known-keys loop; both live here so the two stores stay in sync.
// =============================================================================

// Read the preload-exposed electronAPI, typed as the caller's interface.
// Returns null when no API is present (e.g. tests / non-Electron contexts).
export function getElectronAPI<T>(): T | null {
  if (typeof window !== 'undefined' && (window as unknown as Record<string, unknown>).electronAPI) {
    return (window as unknown as Record<string, unknown>).electronAPI as T
  }
  return null
}

// Copy only the keys present in `defaults` from `stored` onto a fresh patch,
// skipping undefined values. Used to project a stored JSON object onto the
// known shape of a store.
export function mergeKnown<T extends object>(defaults: T, stored: Partial<T>): Partial<T> {
  const out: Partial<T> = {}
  for (const key of Object.keys(defaults) as (keyof T)[]) {
    if (key in stored && stored[key] !== undefined) {
      ;(out as Record<string, unknown>)[key as string] = stored[key]
    }
  }
  return out
}

/**
 * Wrap an async projection load so every caller in a renderer window shares the
 * same request. Projection stores are hydrated once and subsequently kept fresh
 * by their change subscription; repeated shell/App hydration must not issue
 * duplicate IPC reads.
 */
export function loadOnce(load: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | null = null
  return () => {
    pending ??= load()
    return pending
  }
}
