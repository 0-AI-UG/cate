// services/browser desktop side, in the renderer: the page bridge (preload)
// and the workspace partitions the desktop shell fills for its webviews.

import { workspacePartition, type BrowserPageBridge } from '../../contract'

let bridge: BrowserPageBridge | null = null

/** The desktop shell installs its page bridge (preload); other shells none. */
export function installBrowserPageBridge(next: BrowserPageBridge | null): void {
  bridge = next
}

export function browserPageBridge(): BrowserPageBridge | null {
  return bridge
}

/** The shell's partitions: null for a workspace whose partition is not
 *  prepared yet, and a signal when that changes. */
export interface BrowserPartitionSource {
  partition(workspaceId: string): string | null
  subscribe(listener: () => void): () => void
}

let source: BrowserPartitionSource | null = null
const listeners = new Set<() => void>()
let stopSource: (() => void) | null = null

/** The shell names each workspace's partition (`persist:ws-<runtimeId>`), since
 *  it knows the runtime id behind a workspace and routes that partition
 *  through the workspace's loopback proxy. */
export function installBrowserPartitions(next: BrowserPartitionSource | null): void {
  stopSource?.()
  source = next
  const notify = () => { for (const listener of [...listeners]) listener() }
  stopSource = next ? next.subscribe(notify) : null
  notify()
}

/** The workspace's partition, or null while the shell prepares it. Without a
 *  shell source every workspace has its own named partition. */
export function browserPartition(workspaceId: string): string | null {
  if (source) return source.partition(workspaceId)
  return workspacePartition(workspaceId.replace(/[^A-Za-z0-9_-]/g, '_'))
}

export function subscribeBrowserPartitions(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
