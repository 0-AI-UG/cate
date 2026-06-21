// =============================================================================
// Filesystem IPC handlers — file read/write and directory watching
// =============================================================================

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
// Local watcher pool. Workspace-tree watching lives in ONE place — the shared
// @parcel/watcher pool (runtime/capabilities/fileWatcher.ts), which owns the OS
// watcher, covering-root sharing, native exclusion pruning, and error
// containment. This module layers only the local concerns on top: a per-window
// trailing-edge debounce + the FS_WATCH_EVENT IPC dispatch, and the in-process
// subscription the git monitor uses. `getExclusions` reads the live
// fileExclusions setting so refreshWatcherIgnores() re-applies edits via the
// pool's refresh().
// ---------------------------------------------------------------------------

const watchPool = createWatchPool(
  () => currentExclusionSet(),
  (root, err) => log.warn('[fs-watch] watcher error for %s: %O', root, err),
)

/** Trailing-edge debounce window for coalescing watcher bursts. */
const DISPATCH_DEBOUNCE_MS = 16

/** An active renderer watch: the pool unsubscribe + the debounce canceller, so
 *  watchStop and window-close tear the subscription down precisely. */
interface RendererWatch {
  windowId: number
  unsubscribe: () => void
  cancelFlush: () => void
}

/** Active renderer watches keyed by `${windowId}:${dirPath}`. */
const rendererWatches = new Map<string, RendererWatch>()

function watcherKey(windowId: number, dirPath: string): string {
  return `${windowId}:${dirPath}`
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
} from '../../runtime/capabilities/file'
import { createWatchPool } from '../../runtime/capabilities/fileWatcher'
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

function watchStart(dirPath: string, ownerWindowId: number): void {
  const key = watcherKey(ownerWindowId, dirPath)

  // Replace any existing subscription for this window+path.
  watchStop(dirPath, ownerWindowId)

  // Per-window trailing-edge debounce — coalesces a burst (e.g. git status or a
  // multi-file save) into a single IPC dispatch ~16ms after the last event,
  // keeping the renderer-visible payload shape unchanged.
  const dispatcher = createKeyedDispatcher<{ type: string; path: string }>(
    DISPATCH_DEBOUNCE_MS,
    (events) => {
      try {
        for (const event of events) sendToWindow(ownerWindowId, FS_WATCH_EVENT, event)
      } catch (err) {
        log.warn('[fs-watch] flush failed:', err)
      }
    },
  )

  // The pool delivers only events under `dirPath` (prefix-filtered), with
  // parcel's native create/update/delete type. The shared OS watcher is reused
  // when a covering root is already watched (e.g. the git monitor's in-proc
  // subscription on the same workspace).
  const unsubscribe = watchPool.subscribe(dirPath, (filePath, type) => {
    dispatcher.push([filePath, { type, path: filePath }])
  })

  rendererWatches.set(key, {
    windowId: ownerWindowId,
    unsubscribe,
    // cancelFlush clears the timer AND drops pending events for this watch.
    cancelFlush: () => dispatcher.cancel({ resetPending: true }),
  })
}

function watchStop(dirPath: string, ownerWindowId: number): void {
  const key = watcherKey(ownerWindowId, dirPath)
  const watch = rendererWatches.get(key)
  if (!watch) return
  watch.cancelFlush()
  watch.unsubscribe()
  rendererWatches.delete(key)
}

/**
 * Rebuild every pooled watcher with the current ignore list. Called when the
 * user edits the fileExclusions setting so already-running watchers honor the
 * new list without an app restart. Subscribers are preserved across the swap;
 * the displayed tree is refreshed separately via the SETTINGS_CHANGED event.
 */
export function refreshWatcherIgnores(): void {
  void watchPool.refresh().catch((err) => log.warn('[fs-watch] ignore refresh failed: %O', err))
}

// ---------------------------------------------------------------------------
// In-process fs change subscriptions
//
// Lets other main-process modules (e.g. the git monitor) react to filesystem
// events without round-tripping through IPC. Backed by the same pool, so an
// in-proc subscription shares the workspace-root OS watcher when one is already
// open and otherwise opens its own — delivering parcel's real change type
// (create/update/delete) with no coalescing (callers debounce themselves).
// ---------------------------------------------------------------------------

type InProcListener = (filePath: string, type: FsChangeType) => void

export function subscribeFsChanges(prefix: string, listener: InProcListener): () => void {
  return watchPool.subscribe(prefix, listener)
}

/**
 * Stop all watchers owned by a specific window (called on window close).
 */
export function stopWatchersForWindow(windowId: number): void {
  for (const [key, watch] of [...rendererWatches.entries()]) {
    if (watch.windowId !== windowId) continue
    watch.cancelFlush()
    watch.unsubscribe()
    rendererWatches.delete(key)
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
