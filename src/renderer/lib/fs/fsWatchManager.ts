// =============================================================================
// fsWatchManager — renderer-side refcounted multiplexer over the main-process
// filesystem watcher.
//
// A root is shared only within its authorization scope. Separate workspaces
// may legitimately watch the same additional root; releasing one must neither
// revoke the other's watch nor retain the first workspace's stale grant.
// =============================================================================

import { awaitWorkspaceSync } from '../../stores/appStore/helpers'

export interface FsWatchEvent {
  type: 'create' | 'update' | 'delete'
  path: string
  scopeId?: string
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

  const key = JSON.stringify([rootPath, workspaceId])
  let entry = entries.get(key)
  if (!entry) {
    const created: Entry = { listeners: new Set(), unsubscribe: null, started: false }
    entries.set(key, created)
    const rootPosix = toPosix(rootPath)
    // onFsWatchEvent delivers every watch event for this window; only forward
    // those under this root (matters when multiple roots are watched at once).
    // Subscribed synchronously so events are caught the moment the watcher starts.
    created.unsubscribe = window.electronAPI.onFsWatchEvent((event) => {
      if (event.scopeId === workspaceId && (toPosix(event.path) === rootPosix || toPosix(event.path).startsWith(`${rootPosix.replace(/\/$/, '')}/`))) {
        entries.get(key)?.listeners.forEach((l) => l(event))
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
      if (entries.get(key) !== created) return
      created.started = true
      window.electronAPI?.fsWatchStart(rootPath, workspaceId).catch(() => { /* watcher unavailable */ })
    })
    entry = created
  }

  entry.listeners.add(listener)

  return () => {
    const e = entries.get(key)
    if (!e) return
    e.listeners.delete(listener)
    if (e.listeners.size === 0) {
      e.unsubscribe?.()
      entries.delete(key)
      // Only stop a watcher we actually started — see Entry.started.
      if (e.started) {
        window.electronAPI?.fsWatchStop(rootPath, workspaceId).catch(() => { /* already gone */ })
      }
    }
  }
}
