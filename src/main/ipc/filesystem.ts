// =============================================================================
// Filesystem IPC handlers — file read/write and directory watching
// =============================================================================

import path from 'path'
import { watch, FSWatcher } from 'chokidar'
import { ipcMain } from 'electron'
import log from '../logger'
import { consumeScopedWriteAllowance, validatePathStrict } from './pathValidation'
import { parseLocator, formatLocator, LOCAL_COMPANION_ID } from '../companion/locator'
import { companions } from '../companion/companionManager'
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
function currentExclusionSet(): Set<string> {
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
// (src/companion/capabilities/file.ts) so the local process and the standalone
// companion daemon share ONE implementation. Path-only ops are re-exported
// verbatim; the two ops that need the live `fileExclusions` setting (readDir,
// searchFiles) and import-entry logging are wrapped below to inject it.
// -----------------------------------------------------------------------------

export {
  readFile,
  readBinary,
  writeFile,
  statEntry,
  removeEntry,
  renameEntry,
  mkdirEntry,
  copyInto,
} from '../../companion/capabilities/file'

import {
  readDir as capReadDir,
  searchFiles as capSearchFiles,
  importEntriesInto as capImportEntriesInto,
} from '../../companion/capabilities/file'

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
// companion. `formatLocator` is a no-op for the local companion, so these are
// safe (and identity-preserving) for local workspaces.
// ---------------------------------------------------------------------------

function encodeResultPath(companionId: string, p: string): string {
  return formatLocator({ companionId, path: p })
}

/** Re-encode every absolute `path` in a file tree (recursively, for safety). */
function encodeTreeNodes(companionId: string, nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes.map((node) => ({
    ...node,
    path: encodeResultPath(companionId, node.path),
    children: node.children?.length ? encodeTreeNodes(companionId, node.children) : node.children,
  }))
}

// Chokidar ignore list: always-hidden dotfiles plus the user's exclusions.
//
// Each exclusion emits two globs so the watcher's notion of "excluded" matches
// readDir/searchFiles, which drop any entry whose basename is in the set — a
// folder, the files inside it, or a same-named file. The first glob (`**/<name>`)
// matches the entry itself at any depth (picomatch lets a leading `**/` match
// zero dirs); the second (`**/<name>/**`) matches everything beneath an excluded
// folder. Glob metacharacters in `name` are rejected at the settings input, so
// these patterns only ever match a literal path segment.
function buildIgnoreList(): Array<RegExp | string> {
  return [
    /(^|[/\\])\../, // hidden files
    ...getSettingSync('fileExclusions').flatMap((name) => [`**/${name}`, `**/${name}/**`]),
  ]
}

/**
 * Create a chokidar watcher rooted at `dirPath` and wire its raw events to fan
 * out to `subscribers`. The Map is captured by reference, so subscribers added
 * after creation (and across watcher recreation) are honored.
 */
function createWatcher(dirPath: string, subscribers: Map<string, SubscriberEntry>): FSWatcher {
  const watcher = watch(dirPath, {
    ignoreInitial: true,
    depth: 1,
    ignored: buildIgnoreList(),
  })
  const fanOut = (type: string, fp: string) => {
    for (const sub of subscribers.values()) {
      if (pathHasPrefix(fp, sub.prefix)) sub.dispatch(type, fp)
    }
  }
  watcher.on('add', (fp: string) => fanOut('create', fp))
  watcher.on('change', (fp: string) => fanOut('update', fp))
  watcher.on('unlink', (fp: string) => fanOut('delete', fp))
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
  let pendingEvents = new Map<string, { type: string; path: string }>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  const queueEvent = (type: string, filePath: string) => {
    pendingEvents.set(filePath, { type, path: filePath })
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        const events = pendingEvents
        pendingEvents = new Map()
        flushTimer = null
        try {
          for (const event of events.values()) {
            sendToWindow(ownerWindowId, FS_WATCH_EVENT, event)
          }
        } catch (err) {
          log.warn('[fs-watch] flush failed:', err)
        }
      }, DISPATCH_DEBOUNCE_MS)
    }
  }

  const cancelFlush = () => {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    pendingEvents = new Map()
  }

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

type InProcListener = (filePath: string) => void

interface InProcSub {
  prefix: string
  listener: InProcListener
  // Reverse-lookup of (watcherRoot, key) we've attached to so we can detach
  // on unsubscribe without scanning.
  attachments: Array<{ root: string; key: string }>
}

let inProcSeq = 0
const inProcSubs: Map<number, InProcSub> = new Map()

function attachInProcToWatcher(sub: InProcSub, root: string, shared: SharedWatcher): void {
  const key = `inproc:${inProcSeq}-${root}`
  shared.subscribers.set(key, {
    prefix: sub.prefix,
    // No coalescing here — in-process consumers are expected to debounce
    // themselves if they care; passing every event through makes "immediate
    // poll on change" behaviour easy to reason about.
    dispatch: (_type, filePath) => sub.listener(filePath),
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
  const sub: InProcSub = { prefix, listener, attachments: [] }
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
// Remote fs-watch — for non-local companions the renderer's watch is served by
// the daemon's watch stream (companion.file.watch). Events are debounced per
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
  companion: ReturnType<typeof companions.resolve>,
  companionId: string,
  remotePath: string,
  dirLocator: string,
  windowId: number,
): void {
  stopRemoteWatch(dirLocator, windowId)

  let pending = new Map<string, { type: string; path: string }>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    const events = pending
    pending = new Map()
    flushTimer = null
    for (const event of events.values()) {
      try { sendToWindow(windowId, FS_WATCH_EVENT, event) } catch { /* window gone */ }
    }
  }
  const onChange = (changedPath: string): void => {
    const locator = formatLocator({ companionId, path: changedPath })
    pending.set(locator, { type: 'update', path: locator })
    if (!flushTimer) flushTimer = setTimeout(flush, DISPATCH_DEBOUNCE_MS)
  }
  const unsubscribe = companion.file.watch(remotePath, onChange)
  remoteWatches.set(remoteWatchKey(windowId, dirLocator), {
    unsubscribe,
    cancelFlush: () => { if (flushTimer) clearTimeout(flushTimer) },
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

export function registerHandlers(): void {
  ipcMain.handle(FS_READ_FILE, async (event, filePath: string) => {
    try {
      const win = windowFromEvent(event)
      const { companionId, path: p } = parseLocator(filePath)
      const companion = companions.resolve(companionId)
      return await companion.file.readFile(await companion.validatePathStrict(p, win?.id))
    } catch (error) {
      log.error(`[${FS_READ_FILE}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(FS_READ_BINARY, async (event, filePath: string) => {
    try {
      const win = windowFromEvent(event)
      const { companionId, path: p } = parseLocator(filePath)
      const companion = companions.resolve(companionId)
      return await companion.file.readBinary(await companion.validatePathStrict(p, win?.id))
    } catch (error) {
      log.error(`[${FS_READ_BINARY}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(FS_WRITE_FILE, async (event, filePath: string, content: string) => {
    try {
      const win = windowFromEvent(event)
      const { companionId, path: p } = parseLocator(filePath)
      const companion = companions.resolve(companionId)
      const safePath = await companion.validatePathForCreation(p, win?.id)
      await companion.file.writeFile(safePath, content)
      if (win) consumeScopedWriteAllowance(win.id, safePath)
    } catch (error) {
      log.error(`[${FS_WRITE_FILE}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(FS_READ_DIR, async (_event, dirPath: string) => {
    try {
      const { companionId, path: p } = parseLocator(dirPath)
      const companion = companions.resolve(companionId)
      const nodes = await companion.file.readDir(await companion.validatePathStrict(p))
      return encodeTreeNodes(companionId, nodes)
    } catch (error) {
      log.error(`[${FS_READ_DIR}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(FS_WATCH_START, async (event, dirPath: string) => {
    try {
      const win = windowFromEvent(event)
      if (!win) return
      const { companionId, path: p } = parseLocator(dirPath)
      if (companionId === LOCAL_COMPANION_ID) {
        watchStart(await validatePathStrict(p), win.id)
      } else {
        startRemoteWatch(companions.resolve(companionId), companionId, p, dirPath, win.id)
      }
    } catch (error) {
      log.error(`[${FS_WATCH_START}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(FS_WATCH_STOP, async (event, dirPath: string) => {
    try {
      const win = windowFromEvent(event)
      if (!win) return
      const { companionId, path: p } = parseLocator(dirPath)
      if (companionId === LOCAL_COMPANION_ID) {
        watchStop(await validatePathStrict(p), win.id)
      } else {
        stopRemoteWatch(dirPath, win.id)
      }
    } catch (error) {
      log.error(`[${FS_WATCH_STOP}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(FS_STAT, async (_event, filePath: string) => {
    try {
      // Use lstat so symlinks are detected; validatePathStrict already resolves
      // the real path, but we stat the original so the caller gets correct info.
      const { companionId, path: p } = parseLocator(filePath)
      const companion = companions.resolve(companionId)
      return await companion.file.stat(await companion.validatePathStrict(p))
    } catch (error) {
      log.error(`[${FS_STAT}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(FS_DELETE, async (_event, filePath: string) => {
    try {
      const { companionId, path: p } = parseLocator(filePath)
      const companion = companions.resolve(companionId)
      await companion.file.remove(await companion.validatePathStrict(p))
    } catch (error) {
      log.error(`[${FS_DELETE}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(FS_RENAME, async (_event, oldPath: string, newPath: string) => {
    try {
      // Phase 1: rename is within a single companion (both bare/local).
      const { companionId, path: oldP } = parseLocator(oldPath)
      const companion = companions.resolve(companionId)
      const { path: newP } = parseLocator(newPath)
      await companion.file.rename(
        await companion.validatePathStrict(oldP),
        await companion.validatePathForCreation(newP),
      )
    } catch (error) {
      log.error(`[${FS_RENAME}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(FS_COPY, async (_event, srcPath: string, destDir: string) => {
    try {
      const { companionId, path: srcP } = parseLocator(srcPath)
      const companion = companions.resolve(companionId)
      const { path: destP } = parseLocator(destDir)
      const safeSrc = await companion.validatePathStrict(srcP)
      const safeDestDir = await companion.validatePathStrict(destP)
      const finalPath = await companion.file.copy(safeSrc, safeDestDir)
      return encodeResultPath(companionId, finalPath)
    } catch (error) {
      log.error(`[${FS_COPY}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  // Import external files/folders (dragged in from the OS file manager) into a
  // workspace directory. The security boundary is the DESTINATION: `destDir`
  // must resolve inside an allowed workspace root. The SOURCE paths originate
  // from a user-initiated OS drag (webUtils.getPathForFile) and may live
  // anywhere — they are only read server-side to copy/move into `destDir`, and
  // their contents are never returned to the renderer. This mirrors the
  // explicit per-window grant model used by the native Open/Save dialogs.
  ipcMain.handle(
    FS_IMPORT_ENTRIES,
    async (event, sources: string[], destDir: string, mode: 'copy' | 'move') => {
      const win = windowFromEvent(event)
      const { companionId, path: destP } = parseLocator(destDir)
      const companion = companions.resolve(companionId)
      const safeDestDir = await companion.validatePathStrict(destP, win?.id)
      const result = await companion.file.importEntries(sources, safeDestDir, mode, win?.id)
      return {
        ...result,
        created: result.created.map((p) => encodeResultPath(companionId, p)),
      }
    },
  )

  ipcMain.handle(FS_MKDIR, async (_event, dirPath: string) => {
    try {
      const { companionId, path: p } = parseLocator(dirPath)
      const companion = companions.resolve(companionId)
      await companion.file.mkdir(await companion.validatePathForCreation(p))
    } catch (error) {
      log.error(`[${FS_MKDIR}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(FS_SEARCH, async (_event, rootPath: string, query: string, options?: FileSearchOptions) => {
    try {
      const { companionId, path: p } = parseLocator(rootPath)
      const companion = companions.resolve(companionId)
      const validRoot = await companion.validatePathStrict(p)
      const trimmed = (query ?? '').trim()
      if (!trimmed) return []
      const results = await companion.file.search(validRoot, trimmed, options ?? {})
      return results.map((r) => ({ ...r, path: encodeResultPath(companionId, r.path) }))
    } catch (error) {
      log.error(`[${FS_SEARCH}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })
}
