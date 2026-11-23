// Opening a workspace (12.1, 9.2), the one flow every client runs and shows:
// select it, connect, receive its first document, settle its trust. While
// that is on the way the workspace is `opening`; a client shows its windows
// only once it is `ready`, so nothing drawn on the way (an empty document,
// a layout the trust answer takes away) is replaced a moment later.
//
// `openTrusted` opens: the connection first, then the trust question once
// its runtime answers. The workspace counts as opening from the call until
// that answer. `workspacePhase` is the rule, `workspacePhaseOf` and
// `subscribeWorkspacePhase` apply it to an open workspace.

import type { WorkspaceConnection, WorkspaceConnections, ConnectionState } from '@client/connections'
import { documentStoreFor, subscribeDocumentStores } from '@client/document'
import { trustStore, type TrustStore } from './trust'
import { workspaceLocation, type WorkspaceList } from './workspaceList'

/** How far a workspace is: `ready` once its first document arrived and its
 *  trust is settled (its windows show, covered while the connection is
 *  down); `opening` while its runtime, that document or the trust answer is
 *  on the way; `unavailable` when the connection failed before; `closed`
 *  without a connection in this client (declined, disconnected). */
export type WorkspacePhase = 'opening' | 'ready' | 'unavailable' | 'closed'

export function workspacePhase(input: { state: ConnectionState | null; synced: boolean; trusting: boolean }): WorkspacePhase {
  const { state, synced, trusting } = input
  if (!state || state.kind === 'closed') return 'closed'
  if (synced && !trusting) return 'ready'
  return state.kind === 'connecting' || state.kind === 'connected' ? 'opening' : 'unavailable'
}

/** Workspaces between `openTrusted` and their trust answer. */
const trusting = new Map<string, number>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) {
    try { listener() } catch { /* isolate listeners */ }
  }
}

function holdTrusting(workspaceId: string): () => void {
  trusting.set(workspaceId, (trusting.get(workspaceId) ?? 0) + 1)
  notify()
  let held = true
  return () => {
    if (!held) return
    held = false
    const left = (trusting.get(workspaceId) ?? 1) - 1
    if (left > 0) trusting.set(workspaceId, left)
    else trusting.delete(workspaceId)
    notify()
  }
}

/** The phase of a workspace in this client now. */
export function workspacePhaseOf(connections: Pick<WorkspaceConnections, 'get'>, workspaceId: string): WorkspacePhase {
  return workspacePhase({
    state: connections.get(workspaceId)?.state ?? null,
    synced: documentStoreFor(workspaceId)?.isSynced() ?? false,
    trusting: trusting.has(workspaceId),
  })
}

/** Calls `listener` whenever what `workspacePhaseOf` reads may have changed. */
export function subscribeWorkspacePhase(
  connections: Pick<WorkspaceConnections, 'get' | 'subscribe'>,
  workspaceId: string,
  listener: () => void,
): () => void {
  let inner: (() => void)[] = []
  const follow = () => {
    for (const stop of inner) stop()
    const connection = connections.get(workspaceId)
    const document = documentStoreFor(workspaceId)
    inner = [connection?.subscribe(listener), document?.subscribe(listener)].filter((stop) => stop !== undefined)
  }
  const onSources = () => { follow(); listener() }
  listeners.add(listener)
  const stops = [connections.subscribe(onSources), subscribeDocumentStores(onSources), () => { listeners.delete(listener) }]
  follow()
  return () => {
    for (const stop of [...stops, ...inner]) stop()
    inner = []
  }
}

/** Resolves true once the connection is connected, false when it closes.
 *  Trust is asked only of a runtime that answers: an incompatible one
 *  answers nothing but its update, so the mismatch is resolved first. */
function whenConnected(connection: WorkspaceConnection | undefined): Promise<boolean> {
  if (!connection) return Promise.resolve(false)
  return new Promise((resolve) => {
    const check = () => {
      const { kind } = connection.state
      if (kind !== 'connected' && kind !== 'closed') return
      off()
      resolve(kind === 'connected')
    }
    const off = connection.subscribe(check)
    check()
  })
}

/** After a workspace was opened: waits for its runtime and makes sure the
 *  workspace is trusted, asking through `store` when it is not. `declined`:
 *  the person said no; `closed`: the connection closed first. */
async function ensureOpenedTrusted(
  deps: { workspaces: Pick<WorkspaceList, 'get'>; connections: Pick<WorkspaceConnections, 'get'>; store?: TrustStore },
  workspaceId: string,
): Promise<'trusted' | 'declined' | 'closed'> {
  const entry = deps.workspaces.get(workspaceId)
  if (!entry || !(await whenConnected(deps.connections.get(workspaceId)))) return 'closed'
  const label = workspaceLocation(entry) ?? entry.name
  return (await (deps.store ?? trustStore).ensureTrusted(workspaceId, label)) ? 'trusted' : 'declined'
}

/** Opens a workspace (when it is not open) the way every client does: the
 *  connection first, then the trust question once its runtime answers; a
 *  declined workspace is disconnected again but stays in the list (closing
 *  it would drop a paired one's pinned key). The workspace is `opening`
 *  until the answer. Rejects when opening fails;
 *  `trusted` settles once the question is answered. */
export async function openTrusted(
  deps: {
    workspaces: Pick<WorkspaceList, 'get' | 'getSnapshot' | 'open' | 'disconnect'>
    connections: Pick<WorkspaceConnections, 'get'>
    store?: TrustStore
  },
  workspaceId: string,
): Promise<{ trusted: Promise<boolean> }> {
  if (deps.workspaces.getSnapshot().open.includes(workspaceId)) return { trusted: Promise.resolve(true) }
  const release = holdTrusting(workspaceId)
  try {
    await deps.workspaces.open(workspaceId)
  } catch (err) {
    release()
    throw err
  }
  const trusted = ensureOpenedTrusted(deps, workspaceId).then((answer) => {
    if (answer === 'declined') deps.workspaces.disconnect(workspaceId)
    return answer === 'trusted'
  }).finally(release)
  return { trusted }
}
