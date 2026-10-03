// The core's state for the app: every paired workspace, its connection and,
// once the document arrives, its panels. Recomputed and pushed whole on any
// change, coalesced to one push per task; it is small.

import { connectionLabel, connectionRemedy, type ConnectionState } from '@client/connections'
import { documentStoreFor, subscribeDocumentStores } from '@client/document'
import type { PairedWorkspace } from '@client/workspaces'
import { panelDefinition } from '@panels/definitions'
import type { MobileConnection, MobileCoreState, MobilePanel, MobileWorkspace } from '../contract'
import type { MobileClient } from './boot'

export function connectionOf(state: ConnectionState): MobileConnection {
  const text = connectionLabel(state) ?? (state.kind === 'connected' ? 'Connected' : 'Not connected')
  return { kind: state.kind, text, retryable: connectionRemedy(state) !== null }
}

function panelsOf(workspaceId: string): MobilePanel[] | null {
  const store = documentStoreFor(workspaceId)
  if (!store?.isSynced()) return null
  return Object.values(store.getSnapshot().panels).map((panel) => {
    const typeLabel = panelDefinition(panel.type)?.label ?? panel.type
    return { id: panel.id, type: panel.type, typeLabel, title: panel.title || typeLabel }
  })
}

export function snapshotOf(client: MobileClient): MobileCoreState {
  const workspaces: MobileWorkspace[] = client.workspaces.getSnapshot().entries
    .filter((entry): entry is PairedWorkspace => entry.kind === 'paired')
    .map((entry) => {
      const connection = client.connections.get(entry.id)
      return {
        id: entry.id,
        name: entry.name,
        runtimeId: entry.runtimeId,
        connection: connectionOf(connection?.getState() ?? { kind: 'closed' }),
        panels: connection ? panelsOf(entry.id) : null,
      }
    })
  return { workspaces }
}

/** Calls `onChange` (coalesced) whenever the snapshot may have changed. */
export function watchState(client: MobileClient, onChange: () => void): () => void {
  let queued = false
  const schedule = () => {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      rewire()
      onChange()
    })
  }

  // Listeners on each open connection and document, rewired as they come and go.
  const wired = new Map<object, () => void>()
  const rewire = () => {
    const live = new Set<object>()
    for (const connection of client.connections.getSnapshot()) {
      live.add(connection)
      if (!wired.has(connection)) wired.set(connection, connection.subscribe(schedule))
      const store = documentStoreFor(connection.workspaceId)
      if (store) {
        live.add(store)
        if (!wired.has(store)) wired.set(store, store.subscribe(schedule))
      }
    }
    for (const [target, stop] of wired) {
      if (live.has(target)) continue
      wired.delete(target)
      stop()
    }
  }

  const stops = [
    client.workspaces.subscribe(schedule),
    client.connections.subscribe(schedule),
    subscribeDocumentStores(schedule),
  ]
  rewire()
  return () => {
    for (const stop of stops) stop()
    for (const stop of wired.values()) stop()
    wired.clear()
  }
}

