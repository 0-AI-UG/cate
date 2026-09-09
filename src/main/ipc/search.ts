// =============================================================================
// Search IPC — bridges the ripgrep engine to the renderer.
//
//   SEARCH_START (invoke)  -> returns a searchId; streams results to the sender
//   SEARCH_CANCEL (invoke) -> cancels the sender's in-flight search
//   SEARCH_RESULT (send)   -> { searchId, files } batches
//   SEARCH_DONE   (send)   -> { searchId, stats, error? }
//
// Searches are keyed by sender and request ID so independent panels can coexist.
// =============================================================================

import { ipcMain } from 'electron'
import { SEARCH_START, SEARCH_CANCEL, SEARCH_RESULT, SEARCH_DONE } from '../../shared/ipc-channels'
import type { SearchOptions, SearchStats } from '../../shared/types'
import type { SearchHandle } from '../../runtime/search/engine'
import { parseLocator, formatLocator } from '../../shared/runtimeLocator'
import { runtimes } from '../runtime/runtimeManager'
import { windowFromEvent } from '../windowRegistry'

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.max(min, Math.min(max, n))
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** Coerce untrusted renderer input into a safe SearchOptions. */
function sanitize(raw: Partial<SearchOptions> | undefined): SearchOptions {
  return {
    query: String(raw?.query ?? ''),
    isRegex: !!raw?.isRegex,
    matchCase: !!raw?.matchCase,
    wholeWord: !!raw?.wholeWord,
    includes: stringArray(raw?.includes),
    excludes: stringArray(raw?.excludes),
    respectIgnore: raw?.respectIgnore !== false,
    maxResults: clampInt(raw?.maxResults, 2000, 1, 20000),
  }
}

interface SearchOperation {
  ownerWindowId: number | undefined
  runtimeId: string
  handle?: SearchHandle
  finished: boolean
  finish(stats: SearchStats, error?: string, notify?: boolean): void
}
const active = new Map<number, Map<string, SearchOperation>>()
const interruptedStats: SearchStats = { matches: 0, files: 0, truncated: false }

function cancelOperation(operation: SearchOperation, error?: string): void {
  if (operation.finished) return
  operation.finish(interruptedStats, error, !!error)
  operation.handle?.cancel()
}

/** BrowserWindow identity is deliberately distinct from IPC sender identity. */
export function stopSearchesForWindow(windowId: number): void {
  for (const searches of active.values()) {
    for (const operation of searches.values()) {
      if (operation.ownerWindowId === windowId) cancelOperation(operation)
    }
  }
}

export function registerHandlers(): void {
  runtimes.onDisconnected(runtimeId => {
    for (const searches of active.values()) {
      for (const operation of searches.values()) {
        if (operation.runtimeId === runtimeId) cancelOperation(operation, 'Search interrupted: runtime disconnected')
      }
    }
  })
  ipcMain.handle(
    SEARCH_START,
    async (event, rootPath: string, searchIdRaw: string, optsRaw: Partial<SearchOptions>, workspaceId?: string): Promise<string> => {
      const wc = event.sender
      const wcId = wc.id
      // Clamp the renderer-supplied correlation id defensively.
      const searchId = (typeof searchIdRaw === 'string' ? searchIdRaw : '').slice(0, 128)

      // Only a repeated request ID supersedes its own search.
      let searches = active.get(wcId)
      if (!searches) { searches = new Map(); active.set(wcId, searches) }
      const previous = searches.get(searchId)
      if (previous) cancelOperation(previous)
      searches.delete(searchId)

      const opts = sanitize(optsRaw)
      if (!opts.query.trim()) return searchId

      // The root is a runtime locator. Resolve which host owns it and run the
      // search there: the local machine spawns its bundled ripgrep, a remote
      // (SSH/WSL) daemon spawns the ripgrep shipped in its tarball — so a remote
      // workspace is searched on the remote, not against a bogus local path.
      const { runtimeId, path: rootRel } = parseLocator(rootPath)
      const runtime = runtimes.resolve(runtimeId)

      const operation: SearchOperation = {
        ownerWindowId: windowFromEvent(event)?.id,
        runtimeId,
        finished: false,
        finish(stats, error, notify = true) {
          if (operation.finished) return
          operation.finished = true
          if (searches.get(searchId) === operation) searches.delete(searchId)
          if (!searches.size && active.get(wcId) === searches) active.delete(wcId)
          if (notify && !wc.isDestroyed()) wc.send(SEARCH_DONE, { searchId, stats, error })
        },
      }
      searches.set(searchId, operation)
      active.set(wcId, searches)
      try {
        operation.handle = runtime.file.searchContent(rootRel, opts, {
          onBatch: files => {
            if (operation.finished || wc.isDestroyed()) return
            const encoded = files.map(f => ({ ...f, path: formatLocator({ runtimeId, path: f.path }) }))
            wc.send(SEARCH_RESULT, { searchId, files: encoded })
          },
          onDone: (stats, error) => operation.finish(stats, error),
        }, { ownerWindowId: operation.ownerWindowId, scopeId: workspaceId })
        // Completion can occur synchronously while acquiring the handle.
        if (operation.finished) operation.handle?.cancel()
      } catch (error) {
        operation.finish(interruptedStats, error instanceof Error ? error.message : String(error))
      }
      return searchId
    },
  )

  ipcMain.handle(SEARCH_CANCEL, (event, searchId: string): void => {
    const wcId = event.sender.id
    const operation = active.get(wcId)?.get(searchId)
    if (operation) cancelOperation(operation)
  })
}
