// The page operations this client runs for the runtime (architecture 10.2):
// one registry for every panel type. A view registers a handler for its
// panel's surface; a request for a panel with no handler mounts it on demand
// (`demandSurface`) and waits for one. A client serves only if it has a
// surface feature, and the runtime sends it only ops it has the feature for.

import { RpcError, toWireError } from '@kernel/rpc/contract'
import { eachConnection, type WorkspaceConnections } from '@client/connections'
import type { SurfaceRequest } from '@panels/framework/contract'
import { demandSurface } from './surfaceDemand'

export type SurfaceHandler = (request: SurfaceRequest) => unknown | Promise<unknown>

const MOUNT_WAIT_MS = 5_000

const handlers = new Map<string, SurfaceHandler>()
const waiters = new Set<() => void>()
const keyOf = (workspaceId: string, panelId: string | null) => `${workspaceId}\u0000${panelId ?? ''}`

/** A surface's handler: a mounted panel view's (`panelId`), or the
 *  workspace's handler for ops of no panel (`null`: browser code cells).
 *  Returns its removal. */
export function registerSurface(workspaceId: string, panelId: string | null, handler: SurfaceHandler): () => void {
  const key = keyOf(workspaceId, panelId)
  handlers.set(key, handler)
  for (const waiter of [...waiters]) waiter()
  return () => { if (handlers.get(key) === handler) handlers.delete(key) }
}

/** Runs one request on its surface, mounting the panel's view if needed. */
export async function runSurfaceRequest(workspaceId: string, request: SurfaceRequest): Promise<unknown> {
  const key = keyOf(workspaceId, request.panelId)
  const existing = handlers.get(key)
  if (existing) return existing(request)
  if (request.panelId === null) throw new RpcError('no-renderer', `This client cannot run ${request.op}`)
  const release = demandSurface(workspaceId, request.panelId)
  try {
    const handler = await new Promise<SurfaceHandler>((resolve, reject) => {
      const check = () => {
        const found = handlers.get(key)
        if (!found) return
        clearTimeout(timer)
        waiters.delete(check)
        resolve(found)
      }
      const timer = setTimeout(() => {
        waiters.delete(check)
        reject(new RpcError('no-renderer', 'The panel is not open on this client'))
      }, MOUNT_WAIT_MS)
      waiters.add(check)
    })
    return await handler(request)
  } finally {
    release()
  }
}

/** Answers the runtime's page operations on every open connection, when
 *  this client has a surface feature. */
export function serveSurfaces(connections: WorkspaceConnections): () => void {
  return eachConnection(connections, (connection) => {
    if (!connection.clientHas('webview') && !connection.clientHas('pageDriver')) return () => {}
    const { workspaceId } = connection
    const surface = connection.runtime.surface
    const sub = surface.requests(undefined, { resume: true })
    sub.onEvent((request) => {
      void Promise.resolve()
        .then(() => runSurfaceRequest(workspaceId, request))
        .then(
          (result) => surface.reply({ requestId: request.requestId, result }),
          (err) => surface.reply({ requestId: request.requestId, error: toWireError(err) }),
        )
        .catch(() => { /* the connection dropped; the runtime fails the request */ })
    })
    return () => sub.cancel()
  })
}
