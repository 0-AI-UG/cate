// =============================================================================
// fsWatchManager — renderer-side refcounted multiplexer over the main-process
// filesystem watcher.
//
// Main keys watch subscriptions by (windowId, path), so if two components in the
// SAME window each call fsWatchStart for the same root, the second start evicts
// the first and either one's fsWatchStop tears the shared watcher down for both
// (see filesystem.ts watchStart/watchStop). The Explorer (left sidebar) and the
// Search view (right sidebar) can be mounted at the same time, so they'd clobber
// each other that way.
//
// This manager refcounts per root path on the renderer side: it issues exactly
// one fsWatchStart on the 0->1 transition and one fsWatchStop on the 1->0
// transition, and fans the single onFsWatchEvent stream out to every subscriber.
// =============================================================================

import { awaitWorkspaceSync } from '../../stores/appStore/helpers'

export interface FsWatchEvent {
  type: 'create' | 'update' | 'delete'
  path: string
}
type Listener = (event: FsWatchEvent) => void

interface Entry {
  listeners: Set<Listener>
  unsubscribe: (() => void) | null
  /** Whether fsWatchStart was actually issued (it's deferred — see below). The
   *  teardown only calls fsWatchStop when a start was issued, so a quick
   *  subscribe/unsubscribe during the deferral window doesn't try to stop a
   *  watcher that never started (which would log a spurious denial). */
  started: boolean
}

const entries = new Map<string, Entry>()

/** Normalize OS-native separators so a path/prefix comparison is consistent. */
function toPosix(p: string): string {
  return p.indexOf('\\') === -1 ? p : p.replace(/\\/g, '/')
}

/**
 * Subscribe to filesystem-change events under `rootPath`. Returns an unsubscribe
 * function. The underlying watcher is shared and reference-counted, so it stays
 * alive as long as at least one subscriber for that root remains.
 */
export function watchFsRoot(rootPath: string, listener: Listener, workspaceId?: string): () => void {
  if (!rootPath || !window.electronAPI) return () => {}

  let entry = entries.get(rootPath)
  if (!entry) {
    const created: Entry = { listeners: new Set(), unsubscribe: null, started: false }
    entries.set(rootPath, created)
    const rootPosix = toPosix(rootPath)
    // onFsWatchEvent delivers every watch event for this window; only forward
    // those under this root (matters when multiple roots are watched at once).
    // Subscribed synchronously so events are caught the moment the watcher starts.
    created.unsubscribe = window.electronAPI.onFsWatchEvent((event) => {
      if (toPosix(event.path).startsWith(rootPosix)) {
        entries.get(rootPath)?.listeners.forEach((l) => l(event))
      }
    })
    // Defer the watcher start until any in-flight workspace:create/update has
    // registered this root in the main allowedRoots set. A watch requested during
    // session restore would otherwise beat that registration and be denied with
    // "outside allowed directories" — and since the renderer never retries, the
    // root would stay unwatched for the whole session (breaking the file explorer,
    // git status, and editor external-change detection). awaitWorkspaceSync()
    // resolves immediately when nothing is pending, so steady-state watches are
    // unaffected.
    awaitWorkspaceSync().then(() => {
      // Bail if every subscriber unsubscribed (or the entry was torn down and
      // recreated) while we waited — the current entry owns its own start.
      if (entries.get(rootPath) !== created) return
      created.started = true
      window.electronAPI?.fsWatchStart(rootPath, workspaceId).catch(() => { /* watcher unavailable */ })
    })
    entry = created
  }

  entry.listeners.add(listener)

  return () => {
    const e = entries.get(rootPath)
    if (!e) return
    e.listeners.delete(listener)
    if (e.listeners.size === 0) {
      e.unsubscribe?.()
      entries.delete(rootPath)
      // Only stop a watcher we actually started — see Entry.started.
      if (e.started) {
        window.electronAPI?.fsWatchStop(rootPath, workspaceId).catch(() => { /* already gone */ })
      }
    }
  }
}
