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

import fs from 'fs'
import path from 'path'
import log from '../logger'
import { LOCAL_RUNTIME_ID, parseLocator, type RuntimeId } from '../runtime/locator'
import { runtimes } from '../runtime/runtimeManager'
import { getWorkspaceInfo } from '../workspaceManager'
import { hostJoin } from '../../agent/main/agentDir'
import type { Runtime } from '../runtime/types'

/** Reserved sub-object holding per-panel slices. */
const PANELS_KEY = '__panels__'
/** Filename of the per-extension storage file inside `.cate/extensions/<id>/`. */
const STORAGE_BASENAME = 'storage.json'
/** Debounce window for batching writes (matches the old jsonStateFile cadence). */
const WRITE_DEBOUNCE_MS = 150

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

/** Read + parse the host file, or {} when missing/corrupt. */
async function loadData(file: string, host: Runtime['file']): Promise<StorageShape> {
  try {
    const parsed = JSON.parse(await host.readFile(file)) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...(parsed as StorageShape) }
    }
  } catch {
    // Missing file or invalid JSON → start from defaults.
  }
  return {}
}

async function createStore(runtimeId: RuntimeId, file: string): Promise<Store> {
  // Resolve the runtime FRESH per operation from the registry rather than
  // capturing it: a disconnect/reconnect builds a NEW Runtime under the same id,
  // and this long-lived store must write/read/watch through the CURRENT one, not
  // the dead handle it was created with (otherwise writes are silently lost).
  const currentFileHost = (): Runtime['file'] | null => {
    try { return runtimes.resolve(runtimeId).file } catch { return null }
  }

  const host0 = currentFileHost()
  let data: StorageShape = host0 ? await loadData(file, host0) : {}
  const subscribers = new Set<() => void>()
  let writeTimer: ReturnType<typeof setTimeout> | null = null
  /** The runtime watcher disposer, kept so we can stop watching (finding #2). */
  let unwatch: (() => void) | null = null
  /** True while the async watch arming (mkdir + watch) is in flight, so two
   *  concurrent subscribes can't arm two watchers. */
  let watchArming = false
  // The watch pool is directory-recursive (parcel can't root at a file), so we
  // watch the storage file's parent dir and filter events down to the file.
  const dir = file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')))
  // The JSON of our last scheduled write, so the watcher can ignore the change
  // event our own writeFile produces (otherwise every set() would echo back).
  let lastWritten: string | null = null

  const scheduleWrite = (): void => {
    if (writeTimer) return
    writeTimer = setTimeout(() => {
      writeTimer = null
      const host = currentFileHost()
      if (!host) {
        log.warn('[extensions] storage write skipped, runtime %s not connected: %s', runtimeId, file)
        return
      }
      const json = JSON.stringify(data, null, 2)
      lastWritten = json
      void host
        .writeFile(file, json)
        .catch((err) => log.warn('[extensions] storage write failed %s: %O', file, err))
    }, WRITE_DEBOUNCE_MS)
    writeTimer.unref?.()
  }

  const notify = (): void => {
    for (const cb of subscribers) {
      try { cb() } catch { /* a subscriber throwing must not block others */ }
    }
  }

  /** Flush the in-memory data to disk synchronously. Only viable for the local
   *  runtime (a real fs path); mirrors the async writeFile discipline (mkdir the
   *  parent, plain write — no temp+rename). Guarded so it can't throw on shutdown. */
  const flushSync = (): void => {
    const hadTimer = writeTimer != null
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null }
    const json = JSON.stringify(data, null, 2)
    // Nothing pending: no debounced timer AND the latest value is already durable.
    if (!hadTimer && json === lastWritten) return
    if (runtimeId !== LOCAL_RUNTIME_ID) return
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, json)
      lastWritten = json
    } catch (err) {
      log.warn('[extensions] storage sync flush failed %s: %O', file, err)
    }
  }

  const update = (fn: (cur: StorageShape) => StorageShape): void => {
    const before = data
    const next = fn(data)
    data = next
    scheduleWrite()
    // Notify same-process subscribers directly. The watcher suppresses our own
    // write as an echo, so set()/delete()/panelSet() (incl. a server write via
    // CATE_API) would otherwise never fire another panel's onChange. Compare
    // before/after so a no-op write doesn't spuriously fire subscribers.
    if (JSON.stringify(before) !== JSON.stringify(next)) notify()
  }

  const ensureWatching = (): void => {
    if (unwatch || watchArming) return
    const host = currentFileHost()
    if (!host) return
    watchArming = true
    void (async () => {
      try {
        // The watched dir may not exist before the first write; the pool can't
        // watch a missing root. Create it through the runtime so local and
        // remote arm identically. Idempotent (mkdir is recursive).
        await host.mkdir(dir)
        const h = currentFileHost()
        if (!h) return
        const un = h.watch(dir, (changedPath) => {
          // Basename match, not full-path equality: the watcher may emit a
          // different representation of the same path (separators, resolved
          // symlinks) than our hostJoin-built string, and a mismatch here
          // would silently disarm reloads. Editor tmp/backup siblings are
          // filtered out; a same-content event is dropped by the compares.
          if (!changedPath.endsWith(STORAGE_BASENAME)) return
          void (async () => {
            const hh = currentFileHost()
            if (!hh) return
            const fresh = await loadData(file, hh)
            const json = JSON.stringify(fresh, null, 2)
            if (json === lastWritten) return // our own write echoed back
            if (json === JSON.stringify(data, null, 2)) return // no content change
            data = fresh
            notify()
          })()
        })
        // All subscribers left (or the store was disposed) while arming — don't
        // strand a live watcher nothing listens to.
        if (subscribers.size === 0) { un(); return }
        unwatch = un
      } catch (err) {
        log.warn('[extensions] storage watch arming failed for %s: %O', file, err)
      } finally {
        watchArming = false
      }
    })()
  }

  const stopWatching = (): void => {
    if (!unwatch) return
    try { unwatch() } catch { /* disposer must not throw on teardown */ }
    unwatch = null
  }

  const handle: ExtensionStorage = {
    get(key) {
      return data[key]
    },
    set(key, value) {
      update((cur) => ({ ...cur, [key]: value }))
    },
    delete(key) {
      update((cur) => {
        const next = { ...cur }
        delete next[key]
        return next
      })
    },
    keys() {
      return Object.keys(data).filter((k) => k !== PANELS_KEY)
    },
    panelGet(panelId, key) {
      const panels = data[PANELS_KEY]
      if (panels && typeof panels === 'object' && !Array.isArray(panels)) {
        const slice = (panels as Record<string, unknown>)[panelId]
        if (slice && typeof slice === 'object' && !Array.isArray(slice)) {
          return (slice as Record<string, unknown>)[key]
        }
      }
      return undefined
    },
    panelSet(panelId, key, value) {
      update((cur) => {
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
      subscribers.add(cb)
      ensureWatching()
      return () => {
        subscribers.delete(cb)
        // Last subscriber gone → stop the runtime watcher so it isn't left live
        // for a closed panel (finding #2). A later subscriber re-arms it.
        if (subscribers.size === 0) stopWatching()
      }
    },
  }

  const store: Store = {
    handle,
    flushSync,
    dispose() {
      // Persist any pending write BEFORE dropping the timer, so a runtime
      // disconnect (or eviction) doesn't lose a set() still inside the debounce.
      flushSync()
      if (writeTimer) { clearTimeout(writeTimer); writeTimer = null }
      subscribers.clear()
      stopWatching()
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
