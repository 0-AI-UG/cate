// The core's state for the app: every paired workspace, its connection and,
// once the document arrives, its panels. Recomputed and pushed whole on any
// change, coalesced to at most one push per frame (`PUSH_MS`); the app takes
// only the parts that changed.

import { clientIdentity, connectionStatus, type ConnectionRemedy, type ConnectionState } from '@client/connections'
import { documentStoreFor, otherClientsOf, subscribeDocumentStores } from '@client/document'
import { trustStore, type PairedWorkspace } from '@client/workspaces'
import { panelCheckoutHooks } from '@client/host'
import { panelDefinition } from '@panels/definitions'
import { canvasOf, dockPanels, type WorkspaceDocument, type WorktreeMeta } from '@workspace/document/contract'
import { panelCheckout } from '@workspace/repository/contract'
import type { MobileCanvas, MobileConnection, MobileConnectionAction, MobileCoreState, MobilePanel, MobileWorkspace, MobileWorktree } from '../contract'
import type { MobileClient } from './boot'
import type { MobileAgents } from './agents'
import { relationFieldsOf, relationsOf, type MobileRelations } from './relations'

const MOBILE_ACTIONS: Partial<Record<ConnectionRemedy, MobileConnectionAction>> = {
  retry: 'retry',
  start: 'retry',
  pair: 'pair',
  forget: 'forget',
}

export function connectionOf(state: ConnectionState, startsRuntime = false): MobileConnection {
  const status = connectionStatus(state, { startsRuntime })
  const text = status?.message ?? (state.kind === 'connected' ? 'Connected' : 'Not connected')
  const actions = [...new Set((status?.remedies ?? []).map((r) => MOBILE_ACTIONS[r]).filter((a): a is MobileConnectionAction => !!a))]
  return { kind: state.kind, title: status?.title ?? '', text, actions }
}

function canvasOfDoc(doc: WorkspaceDocument, canvasId: string | undefined): MobileCanvas | null {
  const canvas = canvasId ? doc.canvases[canvasId] : undefined
  if (!canvas) return null
  return {
    id: canvas.id,
    nodes: Object.values(canvas.nodes).map((node) => ({ id: node.id, rect: { x: node.rect.origin.x, y: node.rect.origin.y, width: node.rect.size.width, height: node.rect.size.height }, panels: dockPanels(node.dock) })),
  }
}

/** The ready checkouts, the main one (the shortest path) first; none unless
 *  two or more, as the desktop's territories and worktree chips. */
function readyWorktrees(doc: WorkspaceDocument): WorktreeMeta[] {
  const ready = Object.values(doc.worktrees).filter((w) => w.status === 'ready')
  return ready.length < 2 ? [] : ready.sort((a, b) => a.path.length - b.path.length)
}

function worktreesOf(doc: WorkspaceDocument): MobileWorktree[] {
  return readyWorktrees(doc).map((w, index) => ({
    id: w.id,
    label: w.label || (index === 0 ? 'main' : w.path.split(/[\\/]/).filter(Boolean).pop() ?? w.path),
    color: w.color,
    isPrimary: index === 0,
  }))
}

function panelsOf(workspaceId: string): MobilePanel[] | null {
  const store = documentStoreFor(workspaceId)
  if (!store?.isSynced()) return null
  const doc = store.getSnapshot()
  const worktrees = readyWorktrees(doc)
  return Object.values(doc.panels).map((panel) => {
    const definition = panelDefinition(panel.type)
    const typeLabel = definition?.label ?? panel.type
    return {
      id: panel.id,
      type: panel.type,
      typeLabel,
      icon: definition?.icon ?? '',
      title: panel.title || typeLabel,
      onCanvas: canvasOf(doc, panel.id),
      canvas: canvasOfDoc(doc, panel.canvasId),
      ...relationFieldsOf(panel),
      detail: definition?.describe?.(panel) ?? null,
      worktreeId: panelCheckout(panel, worktrees, panelCheckoutHooks)?.id ?? null,
      switchesWorktree: !!definition?.switchesWorktree,
    }
  })
}

export function snapshotOf(client: MobileClient, agents: MobileAgents, relations: MobileRelations): MobileCoreState {
  const workspaces: MobileWorkspace[] = client.workspaces.getSnapshot().entries
    .filter((entry): entry is PairedWorkspace => entry.kind === 'paired')
    .map((entry) => {
      const connection = client.connections.get(entry.id)
      const store = connection ? documentStoreFor(entry.id) : null
      const relationsEnabled = relations.enabled(entry.id)
      return {
        id: entry.id,
        name: entry.name,
        runtimeId: entry.runtimeId,
        connection: connectionOf(connection?.getState() ?? { kind: 'closed' }, connection?.startsRuntime),
        panels: connection ? panelsOf(entry.id) : null,
        worktrees: store?.isSynced() ? worktreesOf(store.getSnapshot()) : [],
        relations: relationsEnabled && store?.isSynced() ? relationsOf(store.getSnapshot()) : [],
        relationsEnabled,
        agents: agents.agents(entry.id),
        power: agents.power(entry.id),
        push: agents.push(entry.id),
        others: connection ? otherClientsOf(entry.id).map((client) => ({ clientId: client.clientId, name: client.device.name, attentive: client.attentive })) : [],
      }
    })
  return { clientId: clientIdentity().clientId, workspaces, trustPrompt: trustStore.current() }
}

/** The least time between two pushes: one per frame. */
export const PUSH_MS = 16

/** Calls `onChange` (coalesced) whenever the snapshot may have changed. */
export function watchState(client: MobileClient, agents: MobileAgents, relations: MobileRelations, onChange: () => void): () => void {
  let queued: ReturnType<typeof setTimeout> | null = null
  const schedule = () => {
    if (queued) return
    queued = setTimeout(() => {
      queued = null
      rewire()
      onChange()
    }, PUSH_MS)
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
    trustStore.subscribe(schedule),
    client.connections.subscribe(schedule),
    subscribeDocumentStores(schedule),
    agents.subscribe(schedule),
    relations.subscribe(schedule),
  ]
  rewire()
  return () => {
    if (queued) clearTimeout(queued)
    for (const stop of stops) stop()
    for (const stop of wired.values()) stop()
    wired.clear()
  }
}

