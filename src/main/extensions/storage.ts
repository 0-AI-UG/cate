// =============================================================================
// Extension storage — per-extension `cate.storage`, backed by a hand-editable
// JSON file at `<project>/.cate/extensions/<extensionId>/storage.json` ON the
// workspace's runtime host (local OR remote), accessed through `runtime.file.*`.
// This is the single, branch-free path: the daemon owns the disk (local is just
// another daemon), so a remote workspace's extension storage lives on the remote,
// exactly like the workspace's own `.cate/workspace.json` (projectWorkspaceStore).
//
// On-disk layout (one file per extension per project):
//
//   {
//     "<key>": <json value>,            // extension-scoped KV (top level)
//     "__panels__": {                   // reserved per-panel slices
//       "<panelId>": { "<key>": <json value> }
//     }
//   }
//
// `__panels__` is reserved — extension-scoped get/set/delete/keys operate on the
// top level and skip it, so a panel slice can never collide with an extension key.
//
// Each (runtime, project, extensionId) gets one cached store: async initial load
// (runtime.file.readFile), in-memory authority for synchronous get/set, debounced
// runtime.file.writeFile, and a runtime.file.watch on the storage DIR (the watch
// pool is directory-based) that reloads on external edits, suppressing our own
// write echo by content compare.
// =============================================================================

import log from '../logger'
import { LOCAL_RUNTIME_ID, parseLocator, type RuntimeId } from '../runtime/locator'
import { runtimes } from '../runtime/runtimeManager'
import { getWorkspaceInfo } from '../workspaceManager'
import { hostJoin } from '../../agent/main/agentDir'
import type { Runtime } from '../runtime/types'
import { createJsonStateStore } from '../jsonStateStore'
import { writeJsonAtomicSync } from '../writeJsonAtomic'

/** Reserved sub-object holding per-panel slices. */
const PANELS_KEY = '__panels__'
/** Filename of the per-extension storage file inside `.cate/extensions/<id>/`. */
const STORAGE_BASENAME = 'storage.json'
type StorageShape = Record<string, unknown>

/** A live storage handle for one (extensionId, project) pair. Reads/writes are
 *  synchronous against the in-memory authority; writes flush async + debounced. */
export interface ExtensionStorage {
  get(key: string): unknown
  set(key: string, value: unknown): void
  delete(key: string): void
  keys(): string[]
  panelGet(panelId: string, key: string): unknown
  panelSet(panelId: string, key: string, value: unknown): void
  /** Subscribe to external edits (the runtime watcher). Fires with no args;
   *  consumers re-read what they need. Idempotent — one watcher per store. */
  onChange(cb: () => void): () => void
}

interface Store {
  handle: ExtensionStorage
  /** Synchronously persist any pending debounced write, then cancel the timer,
   *  stop the watcher and release resources. Called when a runtime disconnects
   *  (disposeStoresForRuntime) so we don't strand a watcher bound to a dead
   *  runtime handle — and don't drop a set() that was still inside the debounce. */
  dispose(): void
  /** Synchronously persist any pending debounced write and cancel the timer,
   *  without tearing the store down. Best-effort — only a local-runtime store can
   *  be written synchronously (a remote host is reachable only over the async
   *  transport, which is gone by hard-exit). Used by flushAllPendingWritesSync. */
  flushSync(): void
}

// Cache keyed by `<runtimeId>\0<hostFilePath>`; the promise is stored so two
// concurrent first-callers share one async load instead of racing two stores.
const stores = new Map<string, Promise<Store>>()

// Synchronous registry of the RESOLVED stores, so the quit-path flush can persist
// every live store's pending write without awaiting the (cache) promises.
const liveStores = new Set<Store>()

/** Resolve a workspace id to its runtime + host project root, or null. */
function locate(workspaceId: string): { runtime: Runtime; root: string } | null {
  const info = getWorkspaceInfo(workspaceId)
  if (!info) return null
  const { runtimeId, path: root } = parseLocator(info.rootPath)
  if (!root) return null
  try {
    return { runtime: runtimes.resolve(runtimeId), root }
  } catch {
    // Runtime not connected — no storage until it is.
    return null
  }
}

function storageFile(runtimeId: RuntimeId, projectRoot: string, extensionId: string): string {
  return hostJoin(runtimeId, projectRoot, '.cate', 'extensions', extensionId, STORAGE_BASENAME)
}

async function readFile(file: string, host: Runtime['file']): Promise<string | null> {
  try {
    return await host.readFile(file)
  } catch {
    return null
  }
}

function normalizeStorage(parsed: unknown): StorageShape {
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? { ...(parsed as StorageShape) }
    : {}
}

async function createStore(runtimeId: RuntimeId, file: string): Promise<Store> {
  // Resolve the runtime FRESH per operation from the registry rather than
  // capturing it: a disconnect/reconnect builds a NEW Runtime under the same id,
  // and this long-lived store must write/read/watch through the CURRENT one, not
  // the dead handle it was created with (otherwise writes are silently lost).
  const currentFileHost = (): Runtime['file'] | null => {
    try { return runtimes.resolve(runtimeId).file } catch { return null }
  }

  // The watch pool is directory-recursive (parcel can't root at a file), so we
  // watch the storage file's parent dir and filter events down to the file.
  const dir = file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')))

  const state = createJsonStateStore<StorageShape>({
    defaults: {},
    normalize: normalizeStorage,
    backend: {
      read: async () => {
        const host = currentFileHost()
        return host ? readFile(file, host) : null
      },
      write: async (_value, content) => {
        const host = currentFileHost()
        if (!host) throw new Error(`Runtime ${runtimeId} is not connected`)
        await host.writeFile(file, content)
      },
      ...(runtimeId === LOCAL_RUNTIME_ID
        ? { writeSync: (value: StorageShape) => { writeJsonAtomicSync(file, value) } }
        : {}),
      watch: async (onChange) => {
        const host = currentFileHost()
        if (!host) throw new Error(`Runtime ${runtimeId} is not connected`)
        // The watched directory may not exist before the first write.
        await host.mkdir(dir)
        const current = currentFileHost()
        if (!current) throw new Error(`Runtime ${runtimeId} disconnected while arming storage watch`)
        return current.watch(dir, (changedPath) => {
          // Runtime watchers may represent separators/symlinks differently.
          if (changedPath.endsWith(STORAGE_BASENAME)) onChange()
        })
      },
    },
    onInvalid: () => log.warn('[extensions] storage contains invalid JSON: %s', file),
    onError: (operation, err) => log.warn('[extensions] storage %s failed %s: %O', operation, file, err),
  })
  await state.load()

  const handle: ExtensionStorage = {
    get(key) {
      return state.get()[key]
    },
    set(key, value) {
      state.update((cur) => ({ ...cur, [key]: value }))
    },
    delete(key) {
      state.update((cur) => {
        const next = { ...cur }
        delete next[key]
        return next
      })
    },
    keys() {
      return Object.keys(state.get()).filter((k) => k !== PANELS_KEY)
    },
    panelGet(panelId, key) {
      const panels = state.get()[PANELS_KEY]
      if (panels && typeof panels === 'object' && !Array.isArray(panels)) {
        const slice = (panels as Record<string, unknown>)[panelId]
        if (slice && typeof slice === 'object' && !Array.isArray(slice)) {
          return (slice as Record<string, unknown>)[key]
        }
      }
      return undefined
    },
    panelSet(panelId, key, value) {
      state.update((cur) => {
        const panelsRaw = cur[PANELS_KEY]
        const panels =
          panelsRaw && typeof panelsRaw === 'object' && !Array.isArray(panelsRaw)
            ? { ...(panelsRaw as Record<string, Record<string, unknown>>) }
            : {}
        const sliceRaw = panels[panelId]
        const slice =
          sliceRaw && typeof sliceRaw === 'object' && !Array.isArray(sliceRaw)
            ? { ...sliceRaw }
            : {}
        slice[key] = value
        panels[panelId] = slice
        return { ...cur, [PANELS_KEY]: panels }
      })
    },
    onChange(cb) {
      return state.subscribe(() => cb())
    },
  }

  const store: Store = {
    handle,
    flushSync: state.flushSync,
    dispose() {
      state.dispose()
      liveStores.delete(store)
    },
  }
  liveStores.add(store)
  return store
}

/**
 * Get (creating + caching on first use) the storage handle for an extension in a
 * workspace. Returns null when the workspace is unknown or its runtime isn't
 * connected. The handle's get/set are synchronous (in-memory authority); the
 * initial load is awaited here so the first get() already reflects on-disk state.
 */
export async function getExtensionStorage(
  extensionId: string,
  workspaceId: string,
): Promise<ExtensionStorage | null> {
  const loc = locate(workspaceId)
  if (!loc) return null
  const file = storageFile(loc.runtime.id, loc.root, extensionId)
  const cacheKey = `${loc.runtime.id}\0${file}`
  let entry = stores.get(cacheKey)
  if (!entry) {
    entry = createStore(loc.runtime.id, file)
    stores.set(cacheKey, entry)
  }
  return (await entry).handle
}

/**
 * Evict + dispose every cached store bound to `runtimeId` (stop its watcher,
 * cancel any pending write). Exported so ExtensionManager can call it when a
 * runtime disconnects, so watchers/data don't survive against a dead handle.
 * A subsequent getExtensionStorage rebuilds the store against the current runtime.
 */
export function disposeStoresForRuntime(runtimeId: RuntimeId): void {
  const prefix = `${runtimeId}\0`
  for (const key of [...stores.keys()]) {
    if (!key.startsWith(prefix)) continue
    const entry = stores.get(key)
    stores.delete(key)
    void entry?.then((s) => s.dispose()).catch(() => { /* creation failed; nothing to dispose */ })
  }
}

/**
 * Synchronously persist every live store's pending debounced write. Mirrors
 * settingsFile.flushPendingWritesSync and is wired into the quit path
 * (lifecycle/shutdown.ts) so a set() within the ~150ms debounce window survives an
 * immediate quit. Best-effort: only local-runtime stores can be written
 * synchronously, and each store guards its own write, so this never throws.
 */
export function flushAllPendingWritesSync(): void {
  for (const store of [...liveStores]) {
    try { store.flushSync() } catch { /* best-effort during shutdown */ }
  }
}
