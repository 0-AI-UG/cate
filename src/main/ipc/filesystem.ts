// =============================================================================
// Filesystem IPC handlers — file read/write and directory watching
// =============================================================================

import { watch, FSWatcher } from 'chokidar'
import { ipcMain } from 'electron'
import log from '../logger'
import { consumeScopedWriteAllowance, validatePathStrict } from './pathValidation'
import { wrapHandler } from './handlerError'
import { parseLocator, formatLocator, LOCAL_RUNTIME_ID } from '../runtime/locator'
import type { FsChangeType } from '../runtime/types'
import { runtimes, resolveLocator } from '../runtime/runtimeManager'
import { createKeyedDispatcher } from './batchedDispatcher'
import { uploadEntriesToRuntime } from '../runtime/uploadEntries'
import {
  FS_READ_FILE,
  FS_WRITE_FILE,
  FS_READ_DIR,
  FS_WATCH_START,
  FS_WATCH_STOP,
  FS_WATCH_EVENT,
  FS_STAT,
  FS_DELETE,
  FS_RENAME,
  FS_MKDIR,
  FS_COPY,
  FS_IMPORT_ENTRIES,
  FS_SEARCH,
  FS_READ_BINARY,
} from '../../shared/ipc-channels'
import { FileTreeNode, FileSearchResult, FileSearchOptions } from '../../shared/types'
import { sendToWindow, windowFromEvent } from '../windowRegistry'
import { getSettingSync } from '../store'

// Read the user-configured exclusion list live so changes take effect without
// a relaunch. Built into a Set per call for fast membership checks.
export function currentExclusionSet(): Set<string> {
  return new Set(getSettingSync('fileExclusions'))
}

// ---------------------------------------------------------------------------
// Shared watcher pool — one chokidar watcher per normalised directory path,
// shared across any number of windows/requesters via reference counting.
// Per-requester event listeners are tracked separately so each window only
// receives its own events and cleanup is precise.
// ---------------------------------------------------------------------------

interface SubscriberEntry {
  /** Only events whose path startsWith this prefix are dispatched. */
  prefix: string
  /** Per-subscriber dispatch function (a single event at a time). */
  dispatch: (type: string, filePath: string) => void
  /** Cancel any pending trailing-edge flush (called from watchStop). */
  cancelFlush: () => void
}

interface SharedWatcher {
  watcher: FSWatcher
  refCount: number
  /** Per-subscriber entries keyed by an opaque subscriber key. */
  subscribers: Map<string, SubscriberEntry>
}

/** Shared watcher pool keyed by normalised absolute directory path. */
const sharedWatchers: Map<string, SharedWatcher> = new Map()

/** Per-requester key -> normalised path, so watchStop can look up the shared entry. */
const watcherKeys: Map<string, string> = new Map()

function watcherKey(windowId: number, dirPath: string): string {
  return `${windowId}:${dirPath}`
}

/** Trailing-edge debounce window for coalescing chokidar bursts. */
const DISPATCH_DEBOUNCE_MS = 16

/**
 * True iff `filePath` is `prefix` itself or lives under it. Comparison is a
 * straightforward string-prefix check; chokidar emits absolute, OS-normalised
 * paths so we trust them as-is (matching how `dirPath` is stored upstream).
 */
function pathHasPrefix(filePath: string, prefix: string): boolean {
  if (filePath === prefix) return true
  if (!filePath.startsWith(prefix)) return false
  const next = filePath.charCodeAt(prefix.length)
  // 47 = '/', 92 = '\\'
  return next === 47 || next === 92
}

// -----------------------------------------------------------------------------
// Leaf filesystem operations live in the electron-free capability module
// (src/runtime/capabilities/file.ts) so the local process and the standalone
// runtime daemon share ONE implementation. Path-only ops are re-exported
// verbatim; the two ops that need the live `fileExclusions` setting (readDir,
// searchFiles) and import-entry logging are wrapped below to inject it.
// -----------------------------------------------------------------------------

export {
  readFile,
  readBinary,
  writeFile,
  writeBinary,
  statEntry,
  removeEntry,
  renameEntry,
  mkdirEntry,
  copyInto,
} from '../../runtime/capabilities/file'

import {
  readDir as capReadDir,
  searchFiles as capSearchFiles,
  importEntriesInto as capImportEntriesInto,
  createFsIgnoreMatcher,
} from '../../runtime/capabilities/file'
export function readDir(dirPath: string): Promise<FileTreeNode[]> {
  return capReadDir(dirPath, currentExclusionSet())
}

export function searchFiles(
  rootPath: string,
  query: string,
  opts: FileSearchOptions = {},
): Promise<FileSearchResult[]> {
  return capSearchFiles(rootPath, query, currentExclusionSet(), opts)
}

export function importEntriesInto(
  sources: string[],
  safeDestDir: string,
  mode: 'copy' | 'move',
  ownerWindowId?: number,
): Promise<{ created: string[]; failed: number }> {
  return capImportEntriesInto(sources, safeDestDir, mode, ownerWindowId, (src, error) =>
    log.error(`[${FS_IMPORT_ENTRIES}]`, src, error),
  )
}

// ---------------------------------------------------------------------------
// Locator re-encoding — any host path RETURNED to the renderer must be wrapped
// back into a locator so the renderer's next op on that path routes to the same
// runtime. `formatLocator` is a no-op for the local runtime, so these are
// safe (and identity-preserving) for local workspaces.
// ---------------------------------------------------------------------------

function encodeResultPath(runtimeId: string, p: string): string {
  return formatLocator({ runtimeId, path: p })
}

/** Re-encode every absolute `path` in a file tree (recursively, for safety). */
function encodeTreeNodes(runtimeId: string, nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes.map((node) => ({
    ...node,
    path: encodeResultPath(runtimeId, node.path),
    children: node.children?.length ? encodeTreeNodes(runtimeId, node.children) : node.children,
  }))
}

/**
 * Create a chokidar watcher rooted at `dirPath` and wire its raw events to fan
 * out to `subscribers`. The Map is captured by reference, so subscribers added
 * after creation (and across watcher recreation) are honored.
 */
function createWatcher(dirPath: string, subscribers: Map<string, SubscriberEntry>): FSWatcher {
  // Watch the full tree (no `depth` cap): every consumer of a root watch — the
  // editor's external-reload, the explorer tree refresh, the git status store —
  // assumes events arrive for nested paths too. Hidden dirs and the user's
  // exclusions (node_modules, caches, …) are pruned by the ignore matcher, so
  // recursion stays affordable.
  const watcher = watch(dirPath, {
    ignoreInitial: true,
    ignored: createFsIgnoreMatcher(dirPath, currentExclusionSet()),
  })
  const fanOut = (type: string, fp: string) => {
    for (const sub of subscribers.values()) {
      if (pathHasPrefix(fp, sub.prefix)) sub.dispatch(type, fp)
    }
  }

  const dropActiveWatcher = (): void => {
    const shared = sharedWatchers.get(dirPath)
    if (shared?.watcher !== watcher) return

    sharedWatchers.delete(dirPath)
    for (const [key, normPath] of watcherKeys) {
      if (normPath === dirPath) watcherKeys.delete(key)
    }
    for (const sub of subscribers.values()) sub.cancelFlush()
    subscribers.clear()
  }

  const handleError = (err: unknown): void => {
    log.warn('[fs-watch] watcher error for %s: %O', dirPath, err)
    dropActiveWatcher()
    watcher.removeAllListeners()
    void watcher.close()
  }

  watcher.on('add', (fp: string) => fanOut('create', fp))
  watcher.on('change', (fp: string) => fanOut('update', fp))
  watcher.on('unlink', (fp: string) => fanOut('delete', fp))
  watcher.on('error', handleError)
  return watcher
}

function watchStart(dirPath: string, ownerWindowId: number): void {
  const key = watcherKey(ownerWindowId, dirPath)

  // Remove any existing subscription for this window+path first
  watchStop(dirPath, ownerWindowId)

  let shared = sharedWatchers.get(dirPath)

  if (!shared) {
    // First subscriber — create the underlying chokidar watcher. The fan-out
    // (in createWatcher) dispatches each raw event only to subscribers whose
    // `prefix` is an ancestor of the changed path, so IPC consumers (and any
    // in-process listeners such as the git monitor) aren't woken for changes
    // in unrelated subtrees that happen to share the same watcher root.
    const subscribers = new Map<string, SubscriberEntry>()
    shared = {
      watcher: createWatcher(dirPath, subscribers),
      refCount: 0,
      subscribers,
    }
    sharedWatchers.set(dirPath, shared)

    // Attach any previously-registered in-process subscribers whose prefix
    // falls under this newly-created watcher root.
    for (const sub of inProcSubs.values()) {
      if (pathHasPrefix(sub.prefix, dirPath)) {
        attachInProcToWatcher(sub, dirPath, shared)
      }
    }
  }

  // Per-requester trailing-edge debounce — coalesces a burst (e.g. git status
  // or a multi-file save) into a single IPC dispatch ~16ms after the last
  // event, keeping the renderer-visible payload shape unchanged.
  const dispatcher = createKeyedDispatcher<{ type: string; path: string }>(
    DISPATCH_DEBOUNCE_MS,
    (events) => {
      try {
        for (const event of events) {
          sendToWindow(ownerWindowId, FS_WATCH_EVENT, event)
        }
      } catch (err) {
        log.warn('[fs-watch] flush failed:', err)
      }
    },
  )

  const queueEvent = (type: string, filePath: string) => {
    dispatcher.push([filePath, { type, path: filePath }])
  }

  // cancelFlush clears the timer AND drops pending events for this subscriber.
  const cancelFlush = () => dispatcher.cancel({ resetPending: true })

  shared.subscribers.set(key, {
    prefix: dirPath,
    dispatch: queueEvent,
    cancelFlush,
  })
  shared.refCount++
  watcherKeys.set(key, dirPath)
}

function watchStop(dirPath: string, ownerWindowId: number): void {
  const key = watcherKey(ownerWindowId, dirPath)
  const normPath = watcherKeys.get(key)
  if (!normPath) return

  const shared = sharedWatchers.get(normPath)
  if (shared) {
    const sub = shared.subscribers.get(key)
    if (sub) {
      sub.cancelFlush()
      shared.subscribers.delete(key)
      shared.refCount--
    }
    if (shared.refCount <= 0) {
      shared.watcher.close()
      sharedWatchers.delete(normPath)
    }
  }
  watcherKeys.delete(key)
}

/**
 * Rebuild every pooled watcher with the current ignore list. Called when the
 * user edits the fileExclusions setting so already-running watchers honor the
 * new list without an app restart. Subscribers and ref counts are preserved;
 * the displayed tree is refreshed separately via the SETTINGS_CHANGED event.
 */
export function refreshWatcherIgnores(): void {
  for (const [dirPath, shared] of sharedWatchers) {
    const old = shared.watcher
    let next: FSWatcher
    try {
      next = createWatcher(dirPath, shared.subscribers)
    } catch (err) {
      // If the rebuild fails (e.g. invalid path / watcher init error), keep the
      // existing watcher live rather than dropping file events for this root.
      log.warn('[fs-watch] ignore refresh failed for %s; keeping old watcher: %O', dirPath, err)
      continue
    }
    shared.watcher = next
    // Detach the old watcher's listeners before closing it. close() is async,
    // so without this both watchers are briefly live and share the subscribers
    // map — an event landing in that window would fan out twice. IPC consumers
    // dedupe by path, but in-process subscribers (the git monitor) don't.
    old.removeAllListeners()
    old.close().catch((err) => log.warn('[fs-watch] old watcher close failed:', err))
  }
}

// ---------------------------------------------------------------------------
// In-process fs change subscriptions
//
// Lets other main-process modules (e.g. the git monitor) react to filesystem
// events without round-tripping through IPC. Subscribers register a path
// prefix; we deliver any change underneath it via whichever shared watcher
// roots happen to cover it. Subscribers that register before a covering
// watcher exists simply receive nothing until one does, which matches the
// existing renderer-side semantics.
// ---------------------------------------------------------------------------

type InProcListener = (filePath: string, type: FsChangeType) => void

interface InProcSub {
  id: number
  prefix: string
  listener: InProcListener
  // Reverse-lookup of (watcherRoot, key) we've attached to so we can detach
  // on unsubscribe without scanning.
  attachments: Array<{ root: string; key: string }>
}

let inProcSeq = 0
const inProcSubs: Map<number, InProcSub> = new Map()

function attachInProcToWatcher(sub: InProcSub, root: string, shared: SharedWatcher): void {
  const key = `inproc:${sub.id}-${root}`
  shared.subscribers.set(key, {
    prefix: sub.prefix,
    // No coalescing here — in-process consumers are expected to debounce
    // themselves if they care; passing every event through makes "immediate
    // poll on change" behaviour easy to reason about.
    dispatch: (type, filePath) => sub.listener(filePath, type as FsChangeType),
    cancelFlush: () => { /* no-op */ },
  })
  shared.refCount++
  sub.attachments.push({ root, key })
}

/**
 * Subscribe to filesystem change events under `prefix`. The listener fires
 * once per chokidar event whose path is `prefix` itself or lives beneath it,
 * provided some existing watcher root covers `prefix`. Returns an unsubscribe
 * fn. Safe to call even if no covering watcher exists yet — the subscription
 * is registered and will simply produce no events until one does.
 */
export function subscribeFsChanges(prefix: string, listener: InProcListener): () => void {
  const id = ++inProcSeq
  const sub: InProcSub = { id, prefix, listener, attachments: [] }
  inProcSubs.set(id, sub)

  for (const [root, shared] of sharedWatchers) {
    if (pathHasPrefix(prefix, root)) {
      attachInProcToWatcher(sub, root, shared)
    }
  }

  return () => {
    const s = inProcSubs.get(id)
    if (!s) return
    inProcSubs.delete(id)
    for (const { root, key } of s.attachments) {
      const shared = sharedWatchers.get(root)
      if (!shared) continue
      if (shared.subscribers.delete(key)) {
        shared.refCount--
        if (shared.refCount <= 0) {
          shared.watcher.close()
          sharedWatchers.delete(root)
        }
      }
    }
  }
}

/**
 * Stop all watchers owned by a specific window (called on window close).
 */
export function stopWatchersForWindow(windowId: number): void {
  // Collect keys first to avoid mutating the map while iterating
  const toStop: Array<[string, number]> = []
  const prefix = `${windowId}:`
  for (const [key, normPath] of watcherKeys) {
    if (key.startsWith(prefix)) toStop.push([normPath, windowId])
  }
  for (const [normPath, wid] of toStop) {
    watchStop(normPath, wid)
  }
  // Remote watches for this window.
  const remotePrefix = `${windowId}:`
  for (const key of [...remoteWatches.keys()]) {
    if (key.startsWith(remotePrefix)) {
      const entry = remoteWatches.get(key)
      if (entry) { entry.cancelFlush(); entry.unsubscribe(); remoteWatches.delete(key) }
    }
  }
}

// ---------------------------------------------------------------------------
// Remote fs-watch — for non-local runtimes the renderer's watch is served by
// the daemon's watch stream (runtime.file.watch). Events are debounced per
// window (matching the local pool) and re-encoded as locator paths so the
// renderer sees the same representation it subscribed with. Keyed by
// `${windowId}:${dirLocator}`.
// ---------------------------------------------------------------------------
interface RemoteWatchEntry {
  unsubscribe: () => void
  cancelFlush: () => void
}
const remoteWatches = new Map<string, RemoteWatchEntry>()

function remoteWatchKey(windowId: number, dirLocator: string): string {
  return `${windowId}:${dirLocator}`
}

function startRemoteWatch(
  runtime: ReturnType<typeof runtimes.resolve>,
  runtimeId: string,
  remotePath: string,
  dirLocator: string,
  windowId: number,
): void {
  stopRemoteWatch(dirLocator, windowId)

  const dispatcher = createKeyedDispatcher<{ type: string; path: string }>(
    DISPATCH_DEBOUNCE_MS,
    (events) => {
      for (const event of events) {
        try { sendToWindow(windowId, FS_WATCH_EVENT, event) } catch { /* window gone */ }
      }
    },
  )
  const onChange = (changedPath: string, type: FsChangeType): void => {
    const locator = formatLocator({ runtimeId, path: changedPath })
    dispatcher.push([locator, { type, path: locator }])
  }
  const unsubscribe = runtime.file.watch(remotePath, onChange)
  remoteWatches.set(remoteWatchKey(windowId, dirLocator), {
    unsubscribe,
    // Remote cancelFlush only clears the timer (leaves any pending events).
    cancelFlush: () => dispatcher.cancel(),
  })
}

function stopRemoteWatch(dirLocator: string, windowId: number): void {
  const key = remoteWatchKey(windowId, dirLocator)
  const entry = remoteWatches.get(key)
  if (!entry) return
  entry.cancelFlush()
  entry.unsubscribe()
  remoteWatches.delete(key)
}

/** Resolve the file capability for a locator argument, returning the runtime
 *  plus the decoded path and the runtime id (needed to re-encode any path
 *  returned to the renderer). Mirrors git.ts's `vcsFor`. */
function fileRuntimeFor(locator: string): {
  runtime: ReturnType<typeof runtimes.resolve>
  path: string
  runtimeId: string
} {
  return resolveLocator(locator)
}

export function registerHandlers(): void {
  ipcMain.handle(FS_READ_FILE, wrapHandler(`[${FS_READ_FILE}]`, async (event, filePath: string, workspaceId?: string) => {
    const win = windowFromEvent(event)
    const { runtime, path: p } = fileRuntimeFor(filePath)
    return await runtime.file.readFile(await runtime.validatePathStrict(p, win?.id, workspaceId))
  }))

  ipcMain.handle(FS_READ_BINARY, wrapHandler(`[${FS_READ_BINARY}]`, async (event, filePath: string, workspaceId?: string) => {
    const win = windowFromEvent(event)
    const { runtime, path: p } = fileRuntimeFor(filePath)
    return await runtime.file.readBinary(await runtime.validatePathStrict(p, win?.id, workspaceId))
  }))

  ipcMain.handle(FS_WRITE_FILE, wrapHandler(`[${FS_WRITE_FILE}]`, async (event, filePath: string, content: string, workspaceId?: string) => {
    const win = windowFromEvent(event)
    const { runtime, path: p } = fileRuntimeFor(filePath)
    const safePath = await runtime.validatePathForCreation(p, win?.id, workspaceId)
    await runtime.file.writeFile(safePath, content)
    if (win) consumeScopedWriteAllowance(win.id, safePath)
  }))

  ipcMain.handle(FS_READ_DIR, wrapHandler(`[${FS_READ_DIR}]`, async (event, dirPath: string, workspaceId?: string) => {
    const win = windowFromEvent(event)
    const { runtime, path: p, runtimeId } = fileRuntimeFor(dirPath)
    const nodes = await runtime.file.readDir(await runtime.validatePathStrict(p, win?.id, workspaceId))
    return encodeTreeNodes(runtimeId, nodes)
  }))

  ipcMain.handle(FS_WATCH_START, wrapHandler(`[${FS_WATCH_START}]`, async (event, dirPath: string, workspaceId?: string) => {
    const win = windowFromEvent(event)
    if (!win) return
    const { runtimeId, path: p } = parseLocator(dirPath)
    if (runtimeId === LOCAL_RUNTIME_ID) {
      watchStart(await validatePathStrict(p, win.id, workspaceId), win.id)
    } else {
      startRemoteWatch(runtimes.resolve(runtimeId), runtimeId, p, dirPath, win.id)
    }
  }))

  ipcMain.handle(FS_WATCH_STOP, wrapHandler(`[${FS_WATCH_STOP}]`, async (event, dirPath: string, workspaceId?: string) => {
    const win = windowFromEvent(event)
    if (!win) return
    const { runtimeId, path: p } = parseLocator(dirPath)
    if (runtimeId === LOCAL_RUNTIME_ID) {
      watchStop(await validatePathStrict(p, win.id, workspaceId), win.id)
    } else {
      stopRemoteWatch(dirPath, win.id)
    }
  }))

  ipcMain.handle(FS_STAT, wrapHandler(`[${FS_STAT}]`, async (event, filePath: string, workspaceId?: string) => {
    // validatePathStrict resolves and authorizes the path; we stat the
    // resolved path on the owning runtime.
    const win = windowFromEvent(event)
    const { runtime, path: p } = fileRuntimeFor(filePath)
    return await runtime.file.stat(await runtime.validatePathStrict(p, win?.id, workspaceId))
  }))

  ipcMain.handle(FS_DELETE, wrapHandler(`[${FS_DELETE}]`, async (event, filePath: string, workspaceId?: string) => {
    const win = windowFromEvent(event)
    const { runtime, path: p } = fileRuntimeFor(filePath)
    await runtime.file.remove(await runtime.validatePathStrict(p, win?.id, workspaceId))
  }))

  ipcMain.handle(FS_RENAME, wrapHandler(`[${FS_RENAME}]`, async (event, oldPath: string, newPath: string, workspaceId?: string) => {
    // Phase 1: rename is within a single runtime (both bare/local).
    const win = windowFromEvent(event)
    const { runtime, path: oldP } = fileRuntimeFor(oldPath)
    const { path: newP } = parseLocator(newPath)
    await runtime.file.rename(
      await runtime.validatePathStrict(oldP, win?.id, workspaceId),
      await runtime.validatePathForCreation(newP, win?.id, workspaceId),
    )
  }))

  ipcMain.handle(FS_COPY, wrapHandler(`[${FS_COPY}]`, async (event, srcPath: string, destDir: string, workspaceId?: string) => {
    const win = windowFromEvent(event)
    const { runtime, path: srcP, runtimeId } = fileRuntimeFor(srcPath)
    const { path: destP } = parseLocator(destDir)
    const safeSrc = await runtime.validatePathStrict(srcP, win?.id, workspaceId)
    const safeDestDir = await runtime.validatePathStrict(destP, win?.id, workspaceId)
    const finalPath = await runtime.file.copy(safeSrc, safeDestDir)
    return encodeResultPath(runtimeId, finalPath)
  }))

  // Import external files/folders (dragged in from the OS file manager) into a
  // workspace directory. The security boundary is the DESTINATION: `destDir`
  // must resolve inside an allowed workspace root. The SOURCE paths originate
  // from a user-initiated OS drag (webUtils.getPathForFile) and are LOCAL OS
  // paths. For a local workspace they are copied/moved in place on the daemon.
  // For a REMOTE workspace the daemon can't see them, so we read each entry here
  // and stream its bytes to the host via uploadEntriesToRuntime (an upload).
  // Source contents are never returned to the renderer either way.
  ipcMain.handle(
    FS_IMPORT_ENTRIES,
    async (event, sources: string[], destDir: string, mode: 'copy' | 'move', workspaceId?: string) => {
      const win = windowFromEvent(event)
      const { runtime, path: destP, runtimeId } = fileRuntimeFor(destDir)
      const safeDestDir = await runtime.validatePathStrict(destP, win?.id, workspaceId)
      const result =
        runtimeId === LOCAL_RUNTIME_ID
          ? await runtime.file.importEntries(sources, safeDestDir, mode, win?.id)
          : await uploadEntriesToRuntime(runtime, sources, safeDestDir, mode)
      return {
        ...result,
        created: result.created.map((p) => encodeResultPath(runtimeId, p)),
      }
    },
  )

  ipcMain.handle(FS_MKDIR, wrapHandler(`[${FS_MKDIR}]`, async (event, dirPath: string, workspaceId?: string) => {
    const win = windowFromEvent(event)
    const { runtime, path: p } = fileRuntimeFor(dirPath)
    await runtime.file.mkdir(await runtime.validatePathForCreation(p, win?.id, workspaceId))
  }))

  ipcMain.handle(FS_SEARCH, wrapHandler(`[${FS_SEARCH}]`, async (event, rootPath: string, query: string, options?: FileSearchOptions, workspaceId?: string) => {
    const win = windowFromEvent(event)
    const { runtime, path: p, runtimeId } = fileRuntimeFor(rootPath)
    const validRoot = await runtime.validatePathStrict(p, win?.id, workspaceId)
    const trimmed = (query ?? '').trim()
    if (!trimmed) return []
    const results = await runtime.file.search(validRoot, trimmed, options ?? {})
    return results.map((r) => ({ ...r, path: encodeResultPath(runtimeId, r.path) }))
  }))
}
