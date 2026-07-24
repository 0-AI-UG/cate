// =============================================================================
// Filesystem IPC handlers — file read/write and directory watching
// =============================================================================

import { ipcMain } from 'electron'
import log from '../logger'
import { consumeScopedWriteAllowance } from './pathValidation'
import { wrapHandler } from './handlerError'
import { parseLocator, formatLocator, LOCAL_RUNTIME_ID } from '../../shared/runtimeLocator'
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

/** Trailing-edge debounce window for coalescing watcher bursts. */
const DISPATCH_DEBOUNCE_MS = 16

/** An active renderer watch: the runtime unsubscribe + debounce canceller, so
 *  watchStop and window-close tear the subscription down precisely. */
interface RendererWatch {
  windowId: number
  unsubscribe: () => void
  cancelFlush: () => void
}

/** Active renderer watches keyed by `${windowId}:${dirLocator}`. Local and remote
 *  paths share this map and lifecycle; runtime.file.watch is the sole watcher. */
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

function watchStart(dirLocator: string, ownerWindowId: number, scopeId?: string): void {
  watchStop(dirLocator, ownerWindowId)
  const { runtime, runtimeId, path: runtimePath } = resolveLocator(dirLocator)
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
  const unsubscribe = runtime.file.watch(runtimePath, (changedPath, type) => {
    const locator = formatLocator({ runtimeId, path: changedPath })
    dispatcher.push([locator, { type, path: locator }])
  }, { ownerWindowId, scopeId })
  rendererWatches.set(watcherKey(ownerWindowId, dirLocator), {
    windowId: ownerWindowId,
    unsubscribe,
    cancelFlush: () => dispatcher.cancel({ resetPending: true }),
  })
}

function watchStop(dirLocator: string, ownerWindowId: number): void {
  const key = watcherKey(ownerWindowId, dirLocator)
  const watch = rendererWatches.get(key)
  if (!watch) return
  watch.cancelFlush()
  watch.unsubscribe()
  rendererWatches.delete(key)
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
    return await runtime.file.readFile(p, { ownerWindowId: win?.id, scopeId: workspaceId })
  }))

  ipcMain.handle(FS_READ_BINARY, wrapHandler(`[${FS_READ_BINARY}]`, async (event, filePath: string, workspaceId?: string) => {
    const win = windowFromEvent(event)
    const { runtime, path: p } = fileRuntimeFor(filePath)
    return await runtime.file.readBinary(p, { ownerWindowId: win?.id, scopeId: workspaceId })
  }))

  ipcMain.handle(FS_WRITE_FILE, wrapHandler(`[${FS_WRITE_FILE}]`, async (event, filePath: string, content: string, workspaceId?: string) => {
    const win = windowFromEvent(event)
    const { runtime, path: p } = fileRuntimeFor(filePath)
    const safePath = await runtime.file.writeFile(p, content, { ownerWindowId: win?.id, scopeId: workspaceId })
    if (win) consumeScopedWriteAllowance(win.id, safePath)
  }))

  ipcMain.handle(FS_READ_DIR, wrapHandler(`[${FS_READ_DIR}]`, async (event, dirPath: string, workspaceId?: string) => {
    const win = windowFromEvent(event)
    const { runtime, path: p, runtimeId } = fileRuntimeFor(dirPath)
    const nodes = await runtime.file.readDir(p, { ownerWindowId: win?.id, scopeId: workspaceId })
    return encodeTreeNodes(runtimeId, nodes)
  }))

  ipcMain.handle(FS_WATCH_START, wrapHandler(`[${FS_WATCH_START}]`, async (event, dirPath: string, workspaceId?: string) => {
    const win = windowFromEvent(event)
    if (!win) return
    watchStart(dirPath, win.id, workspaceId)
  }))

  ipcMain.handle(FS_WATCH_STOP, wrapHandler(`[${FS_WATCH_STOP}]`, async (event, dirPath: string) => {
    const win = windowFromEvent(event)
    if (!win) return
    watchStop(dirPath, win.id)
  }))

  ipcMain.handle(FS_STAT, wrapHandler(`[${FS_STAT}]`, async (event, filePath: string, workspaceId?: string) => {
    // validatePathStrict resolves and authorizes the path; we stat the
    // resolved path on the owning runtime.
    const win = windowFromEvent(event)
    const { runtime, path: p } = fileRuntimeFor(filePath)
    return await runtime.file.stat(p, { ownerWindowId: win?.id, scopeId: workspaceId })
  }))

  ipcMain.handle(FS_DELETE, wrapHandler(`[${FS_DELETE}]`, async (event, filePath: string, workspaceId?: string) => {
    const win = windowFromEvent(event)
    const { runtime, path: p } = fileRuntimeFor(filePath)
    await runtime.file.remove(p, { ownerWindowId: win?.id, scopeId: workspaceId })
  }))

  ipcMain.handle(FS_RENAME, wrapHandler(`[${FS_RENAME}]`, async (event, oldPath: string, newPath: string, workspaceId?: string) => {
    // Phase 1: rename is within a single runtime (both bare/local).
    const win = windowFromEvent(event)
    const { runtime, path: oldP } = fileRuntimeFor(oldPath)
    const { path: newP } = parseLocator(newPath)
    const safeNewPath = await runtime.file.rename(oldP, newP, { ownerWindowId: win?.id, scopeId: workspaceId })
    if (win) consumeScopedWriteAllowance(win.id, safeNewPath)
  }))

  ipcMain.handle(FS_COPY, wrapHandler(`[${FS_COPY}]`, async (event, srcPath: string, destDir: string, workspaceId?: string) => {
    const win = windowFromEvent(event)
    const { runtime, path: srcP, runtimeId } = fileRuntimeFor(srcPath)
    const { path: destP } = parseLocator(destDir)
    const finalPath = await runtime.file.copy(srcP, destP, { ownerWindowId: win?.id, scopeId: workspaceId })
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
      const access = { ownerWindowId: win?.id, scopeId: workspaceId }
      const result =
        runtimeId === LOCAL_RUNTIME_ID
          ? await runtime.file.importEntries(sources, destP, mode, access)
          : await uploadEntriesToRuntime(runtime, sources, destP, mode, access)
      return {
        ...result,
        created: result.created.map((p) => encodeResultPath(runtimeId, p)),
      }
    },
  )

  ipcMain.handle(FS_MKDIR, wrapHandler(`[${FS_MKDIR}]`, async (event, dirPath: string, workspaceId?: string) => {
    const win = windowFromEvent(event)
    const { runtime, path: p } = fileRuntimeFor(dirPath)
    await runtime.file.mkdir(p, { ownerWindowId: win?.id, scopeId: workspaceId })
  }))

  ipcMain.handle(FS_SEARCH, wrapHandler(`[${FS_SEARCH}]`, async (event, rootPath: string, query: string, options?: FileSearchOptions, workspaceId?: string) => {
    const win = windowFromEvent(event)
    const { runtime, path: p, runtimeId } = fileRuntimeFor(rootPath)
    const trimmed = (query ?? '').trim()
    if (!trimmed) return []
    const results = await runtime.file.search(p, trimmed, options ?? {}, { ownerWindowId: win?.id, scopeId: workspaceId })
    return results.map((r) => ({ ...r, path: encodeResultPath(runtimeId, r.path) }))
  }))
}
