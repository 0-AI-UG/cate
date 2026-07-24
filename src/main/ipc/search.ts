// =============================================================================
// Search IPC — bridges the ripgrep engine to the renderer.
//
//   SEARCH_START (invoke)  -> returns a searchId; streams results to the sender
//   SEARCH_CANCEL (invoke) -> cancels the sender's in-flight search
//   SEARCH_RESULT (send)   -> { searchId, files } batches
//   SEARCH_DONE   (send)   -> { searchId, stats, error? }
//
// One search per sender webContents: starting a new one cancels the previous.
// =============================================================================

import { ipcMain } from 'electron'
import { SEARCH_START, SEARCH_CANCEL, SEARCH_RESULT, SEARCH_DONE } from '../../shared/ipc-channels'
import type { SearchOptions } from '../../shared/types'
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

// One active search per window (keyed by webContents id), so it can be
// cancelled when superseded or when the window is destroyed.
const active = new Map<number, SearchHandle>()

/** Cancel any in-flight search for a destroyed/closed window. */
export function stopSearchesForWindow(windowId: number): void {
  active.get(windowId)?.cancel()
  active.delete(windowId)
}

export function registerHandlers(): void {
  ipcMain.handle(
    SEARCH_START,
    async (event, rootPath: string, searchIdRaw: string, optsRaw: Partial<SearchOptions>, workspaceId?: string): Promise<string> => {
      const wc = event.sender
      const wcId = wc.id
      // Clamp the renderer-supplied correlation id defensively.
      const searchId = (typeof searchIdRaw === 'string' ? searchIdRaw : '').slice(0, 128)

      // A new search supersedes any previous one for this window.
      active.get(wcId)?.cancel()
      active.delete(wcId)

      const opts = sanitize(optsRaw)
      if (!opts.query.trim()) return searchId

      // The root is a runtime locator. Resolve which host owns it and run the
      // search there: the local machine spawns its bundled ripgrep, a remote
      // (SSH/WSL) daemon spawns the ripgrep shipped in its tarball — so a remote
      // workspace is searched on the remote, not against a bogus local path.
      const { runtimeId, path: rootRel } = parseLocator(rootPath)
      const runtime = runtimes.resolve(runtimeId)

      const ownerWindowId = windowFromEvent(event)?.id
      const handle: SearchHandle | undefined = runtime.file.searchContent(rootRel, opts, {
        onBatch: (files) => {
          if (wc.isDestroyed()) return
          // Re-encode each result's absolute path as a runtime locator so the
          // renderer can open it through the same runtime (a no-op for local).
          const encoded = files.map((f) => ({ ...f, path: formatLocator({ runtimeId, path: f.path }) }))
          wc.send(SEARCH_RESULT, { searchId, files: encoded })
        },
        onDone: (stats, error) => {
          if (!wc.isDestroyed()) wc.send(SEARCH_DONE, { searchId, stats, error })
          if (handle && active.get(wcId) === handle) active.delete(wcId)
        },
      }, { ownerWindowId, scopeId: workspaceId })
      active.set(wcId, handle)
      return searchId
    },
  )

  ipcMain.handle(SEARCH_CANCEL, (event): void => {
    const wcId = event.sender.id
    active.get(wcId)?.cancel()
    active.delete(wcId)
  })
}
