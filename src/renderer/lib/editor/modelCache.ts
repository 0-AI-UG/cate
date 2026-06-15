// =============================================================================
// modelCache — module-level Monaco model cache (LRU), ref counting, and the
// load-state guard that keeps a failed file read from overwriting the file.
//
// Kept free of a direct monaco-editor import: it works against a minimal
// ModelLike shape (just dispose/isDisposed) so the cache, LRU eviction, and
// save guard can be unit-tested in a node env without pulling Monaco's DOM and
// worker globals. EditorPanel passes real monaco.editor.ITextModel values in.
// =============================================================================

export interface ModelLike {
  isDisposed(): boolean
  dispose(): void
}

// LRU cap on the Monaco model cache so long sessions don't accumulate models for
// every file the user has ever opened. Oldest entries are disposed on eviction.
export const MODEL_CACHE_LIMIT = 20

const modelCache = new Map<string, ModelLike>()
// Counts how many mounted EditorPanel instances are actively using a cached model.
const modelRefCount = new Map<string, number>()
// Disk content each cached model was last synced with (its sync baseline). Kept
// alongside the model so that when a panel reopens and reattaches a warm model,
// useFileSync can tell unsaved edits (buffer ≠ baseline) apart from a stale-but-
// clean buffer — and reconcile with disk without clobbering unsaved work.
const modelBaseline = new Map<string, string>()
// File paths whose buffer failed to load (read error) or hasn't successfully
// loaded yet. save() consults this to refuse writing an empty/placeholder buffer
// back over the real file.
const loadFailedPaths = new Set<string>()

export function getCachedModel(filePath: string): ModelLike | undefined {
  return modelCache.get(filePath)
}

// Resolve the model to back a freshly-read buffer. Two panels can open the same
// uncached file concurrently; the second createModel() on the now-taken URI
// would throw. Reuse the model the first open already indexed (looked up via
// `getByUri`) rather than creating a duplicate; only `create()` when none lives
// under the URI yet. Kept generic over a lookup/factory pair so it's testable
// without monaco.
export function resolveLoadedModel<T extends ModelLike>(
  getByUri: () => T | null,
  create: () => T,
): T {
  const existing = getByUri()
  if (existing && !existing.isDisposed()) return existing
  return create()
}

export function rememberModel(filePath: string, model: ModelLike): void {
  // Map preserves insertion order — re-insert to mark as most recent.
  modelCache.delete(filePath)
  modelCache.set(filePath, model)
  if (modelCache.size <= MODEL_CACHE_LIMIT) return

  let over = modelCache.size - MODEL_CACHE_LIMIT
  for (const key of [...modelCache.keys()]) {
    if (over <= 0) break
    // Skip a model that is still in use by a mounted editor — but keep scanning
    // so one old in-use file can't block eviction of everything behind it.
    if ((modelRefCount.get(key) ?? 0) > 0) continue
    const model = modelCache.get(key)
    modelCache.delete(key)
    modelBaseline.delete(key)
    if (model && !model.isDisposed()) {
      try { model.dispose() } catch { /* noop */ }
    }
    over--
  }
}

export function retainModel(filePath: string): void {
  modelRefCount.set(filePath, (modelRefCount.get(filePath) ?? 0) + 1)
}

export function releaseModel(filePath: string): void {
  const count = (modelRefCount.get(filePath) ?? 0) - 1
  if (count <= 0) {
    // Drop the refcount entry but DO NOT dispose the model. Keeping it warm in
    // the LRU cache makes the next open of the same file instant (no re-read,
    // no re-tokenization). The LRU eviction path in rememberModel() will
    // dispose the model later if it falls out of the cache.
    modelRefCount.delete(filePath)
  } else {
    modelRefCount.set(filePath, count)
  }
}

// ---------------------------------------------------------------------------
// Disk baseline — the on-disk content a cached model was last synced with. Set
// on load and after every save; recovered on reopen to classify dirty vs stale.
// ---------------------------------------------------------------------------

export function rememberBaseline(filePath: string, content: string): void {
  modelBaseline.set(filePath, content)
}

export function getBaseline(filePath: string): string | undefined {
  return modelBaseline.get(filePath)
}

// ---------------------------------------------------------------------------
// Load-state guard — a buffer that failed to read (or never loaded) must never
// be written back to disk, or Cmd+S from the empty error buffer would truncate
// the file.
// ---------------------------------------------------------------------------

export function markLoadFailed(filePath: string): void {
  loadFailedPaths.add(filePath)
}

export function clearLoadFailed(filePath: string): void {
  loadFailedPaths.delete(filePath)
}

export function isLoadFailed(filePath: string): boolean {
  return loadFailedPaths.has(filePath)
}

/** Test-only reset of all module state. */
export function __resetModelCacheForTest(): void {
  modelCache.clear()
  modelRefCount.clear()
  modelBaseline.clear()
  loadFailedPaths.clear()
}
