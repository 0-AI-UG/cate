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

export interface FsWatchEvent {
  type: 'create' | 'update' | 'delete'
  path: string
}
type Listener = (event: FsWatchEvent) => void

interface Entry {
  listeners: Set<Listener>
  unsubscribe: (() => void) | null
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
    const created: Entry = { listeners: new Set(), unsubscribe: null }
    entries.set(rootPath, created)
    window.electronAPI.fsWatchStart(rootPath, workspaceId).catch(() => { /* watcher unavailable */ })
    const rootPosix = toPosix(rootPath)
    // onFsWatchEvent delivers every watch event for this window; only forward
    // those under this root (matters when multiple roots are watched at once).
    created.unsubscribe = window.electronAPI.onFsWatchEvent((event) => {
      if (toPosix(event.path).startsWith(rootPosix)) {
        entries.get(rootPath)?.listeners.forEach((l) => l(event))
      }
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
      window.electronAPI?.fsWatchStop(rootPath, workspaceId).catch(() => { /* already gone */ })
    }
  }
}
