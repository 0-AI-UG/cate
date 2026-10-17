// Refcounted watches: every subscriber of the same root in the same workspace
// shares one `file.watch` stream, which lives while at least one subscriber
// remains and re-opens after a reconnect.

import { runtimeFor } from '@kernel/rpc/client'
import type { CapabilityProxy, Subscription } from '@kernel/rpc/contract'
import { pathHasPrefix, type FsChange, type fileCapability } from '../contract'

export type FsWatchListener = (change: FsChange) => void

export interface WatchManager {
  /** Watches `root`; returns the unsubscribe. */
  watch(workspaceId: string, root: string, listener: FsWatchListener): () => void
  /** Open streams, for tests and diagnostics. */
  size(): number
}

interface Entry {
  listeners: Set<FsWatchListener>
  sub: Subscription<FsChange[], void> | null
}

export function createWatchManager(
  fileApi: (workspaceId: string) => Pick<CapabilityProxy<typeof fileCapability>, 'watch'> | null,
): WatchManager {
  const entries = new Map<string, Entry>()
  return {
    watch(workspaceId, root, listener) {
      if (!root) return () => {}
      const key = JSON.stringify([workspaceId, root])
      let entry = entries.get(key)
      if (!entry) {
        const created: Entry = { listeners: new Set(), sub: null }
        entries.set(key, created)
        const api = fileApi(workspaceId)
        if (api) {
          const sub = api.watch({ path: root }, { resume: true })
          sub.onEvent((changes) => {
            for (const change of changes) {
              if (!pathHasPrefix(change.path, root)) continue
              for (const l of [...created.listeners]) {
                try { l(change) } catch { /* isolate listeners */ }
              }
            }
          })
          // A refused watch (outside the workspace) just stays silent.
          sub.done.catch(() => {})
          created.sub = sub
        }
        entry = created
      }
      entry.listeners.add(listener)
      const owned = entry
      return () => {
        if (!owned.listeners.delete(listener) || owned.listeners.size > 0) return
        if (entries.get(key) === owned) entries.delete(key)
        owned.sub?.cancel()
      }
    },
    size: () => entries.size,
  }
}

/** The shared manager over the runtime slot. */
export const watchManager: WatchManager = createWatchManager((workspaceId) => {
  try {
    return runtimeFor(workspaceId).file
  } catch {
    return null
  }
})

export function watchFsRoot(workspaceId: string, root: string, listener: FsWatchListener): () => void {
  return watchManager.watch(workspaceId, root, listener)
}
