// Webview wiring (the `webview` and `pageDriver` features): each connected
// workspace's partition is prepared in main (routed through its loopback web
// proxy) before any of its webviews mounts; the browser and chat views and
// T3's cookie use that partition; and page operations the runtime sends to
// this client run on its mounted pages.

import { useSyncExternalStore } from 'react'
import { eachConnection, type WorkspaceConnection, type WorkspaceConnections } from '@client/connections'
import { installBrowserPageBridge, installBrowserPartitions } from '@services/browser/desktop/renderer'
import type { BrowserPageBridge } from '@services/browser/contract'
import { installT3WebviewHost } from '@services/t3/desktop'
import { serveBrowserCode } from '../ui/panels/browser'
import { createLogger } from '@kernel/log/contract'
import type { DesktopApi } from '../contract'

const log = createLogger('webviews')

export interface WebviewPartitions {
  /** The prepared partition of an open workspace, or null until it is ready. */
  partition(workspaceId: string): string | null
  /** Workspaces whose webviews may mount now. */
  ready(): readonly string[]
  /** The open workspace a prepared partition's runtime belongs to. */
  workspaceOf(runtimeId: string): string | null
  subscribe(listener: () => void): () => void
  dispose(): void
}

/** Prepares a partition for each connection once it first connects. */
export function prepareWebviewPartitions(api: DesktopApi, connections: WorkspaceConnections): WebviewPartitions {
  const partitions = new Map<string, string>()
  const runtimes = new Map<string, string>()
  const listeners = new Set<() => void>()
  let ready: readonly string[] = []
  const changed = () => {
    ready = [...partitions.keys()]
    for (const listener of [...listeners]) listener()
  }

  const stop = eachConnection(connections, (connection) => {
    let runtimeId: string | null = null
    let closed = false
    let preparing = false
    const prepare = () => {
      if (preparing || runtimeId || connection.state.kind !== 'connected') return
      preparing = true
      connection.runtime.workspace.info()
        .then(async (info) => {
          const partition = await api.web.partitionFor({ runtimeId: info.runtimeId })
          if (closed) return
          runtimeId = info.runtimeId
          runtimes.set(info.runtimeId, connection.workspaceId)
          partitions.set(connection.workspaceId, partition)
          changed()
        })
        .catch((err: unknown) => log.warn('no browser partition for %s: %s', connection.workspaceId, err))
        .finally(() => { preparing = false })
    }
    const off = connection.subscribe(prepare)
    prepare()
    return () => {
      closed = true
      off()
      if (partitions.delete(connection.workspaceId)) changed()
      if (runtimeId) {
        if (runtimes.get(runtimeId) === connection.workspaceId) runtimes.delete(runtimeId)
        void api.web.release({ runtimeId }).catch(() => {})
      }
    }
  })

  return {
    partition: (workspaceId) => partitions.get(workspaceId) ?? null,
    ready: () => ready,
    workspaceOf: (runtimeId) => runtimes.get(runtimeId) ?? null,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose() {
      stop()
      listeners.clear()
    },
  }
}

export function useWebviewReadyWorkspaces(partitions: WebviewPartitions): readonly string[] {
  return useSyncExternalStore(partitions.subscribe, partitions.ready)
}

/** Browser partitions, the page bridge and T3's cookie host. */
export function installWebviewHosts(api: DesktopApi, partitions: WebviewPartitions, bridge: BrowserPageBridge | undefined): () => void {
  // Only prepared partitions are allowed to host guests; views mount after.
  const partitionOf = (workspaceId: string) => {
    const partition = partitions.partition(workspaceId)
    if (!partition) throw new Error(`The browser partition of ${workspaceId} is not ready`)
    return partition
  }
  // Browser views wait for their partition (a reconnect or a re-run boot
  // can briefly leave a mounted view without one).
  installBrowserPartitions({ partition: (workspaceId) => partitions.partition(workspaceId), subscribe: partitions.subscribe })
  installBrowserPageBridge(bridge ?? null)
  const stopT3 = installT3WebviewHost({
    partition: partitionOf,
    setCookie: (partition, url, cookie) => api.web.setCookie(partition, url, cookie),
  })
  return () => {
    stopT3()
    installBrowserPartitions(null)
    installBrowserPageBridge(null)
  }
}

/** Runs each workspace's browser code cells on the page bridge (the views
 *  register their own panels' page operations with the client host). */
export function serveBrowserCodeCells(connections: WorkspaceConnections, bridge: BrowserPageBridge): () => void {
  return eachConnection(connections, (connection: WorkspaceConnection) =>
    serveBrowserCode(connection.workspaceId, { browserCode: connection.runtime.browserCode, bridge }))
}
