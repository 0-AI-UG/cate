// The driving client (architecture 10.2): the runtime cannot call a client,
// so clients with `pageDriver` subscribe to `surface.requests` and answer
// each request with `surface.reply`. A page operation runs on the driving
// client that most recently showed or used the panel, else the most recently
// active one; with none connected it fails with `no-renderer`.

import { RpcError, fromWireError, type WireError } from '@kernel/rpc/contract'
import type { CapabilityImpl, ConnectionInfo, StreamSink } from '@kernel/rpc/runtime'
import type { PanelId, PresenceClient } from '@workspace/document/contract'
import type { SurfaceRequest, surfaceCapability } from '../contract'

export interface SurfaceBroker {
  request(panelId: PanelId, op: string, args: unknown, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown>
  /** The client that would run a page operation on `panelId` now. */
  driverFor(panelId: PanelId): PresenceClient | null
  dispose(): void
}

export interface SurfaceBrokerDeps {
  presence: { pick(eligible: (client: PresenceClient) => boolean, panelId?: PanelId): PresenceClient | null }
  timeoutMs?: number
}

interface Pending {
  connectionId: number
  resolve(value: unknown): void
  reject(error: Error): void
  cleanup(): void
}

export function createSurfaceBroker(deps: SurfaceBrokerDeps): SurfaceBroker & {
  capability(): CapabilityImpl<typeof surfaceCapability>
} {
  const drivers = new Map<number, StreamSink<SurfaceRequest>>()
  const pending = new Map<number, Pending>()
  let nextId = 1

  const driverFor = (panelId: PanelId) => deps.presence.pick((client) => drivers.has(client.connectionId), panelId)

  const settle = (requestId: number, outcome: { result?: unknown; error?: Error }) => {
    const entry = pending.get(requestId)
    if (!entry) return
    pending.delete(requestId)
    entry.cleanup()
    if (outcome.error) entry.reject(outcome.error)
    else entry.resolve(outcome.result)
  }

  const attach = (connection: ConnectionInfo, sink: StreamSink<SurfaceRequest>) => {
    if (!connection.client || !connection.has('pageDriver')) {
      sink.fail(new RpcError('rejected', 'only clients with pageDriver run page operations'))
      return undefined
    }
    drivers.set(connection.id, sink)
    return () => {
      if (drivers.get(connection.id) === sink) drivers.delete(connection.id)
      for (const [requestId, entry] of [...pending]) {
        if (entry.connectionId === connection.id) settle(requestId, { error: new RpcError('no-renderer', 'the driving client went away') })
      }
    }
  }

  return {
    driverFor,
    request(panelId, op, args, options = {}) {
      const client = driverFor(panelId)
      const sink = client ? drivers.get(client.connectionId) : undefined
      if (!client || !sink) return Promise.reject(new RpcError('no-renderer', 'no connected client can run page operations'))
      const requestId = nextId++
      return new Promise((resolve, reject) => {
        const timeoutMs = options.timeoutMs ?? deps.timeoutMs ?? 30_000
        const timer = timeoutMs > 0
          ? setTimeout(() => settle(requestId, { error: new RpcError('timeout', `${op} timed out`) }), timeoutMs)
          : null
        const onAbort = () => settle(requestId, { error: new RpcError('timeout', `${op} was cancelled`) })
        options.signal?.addEventListener('abort', onAbort)
        pending.set(requestId, {
          connectionId: client.connectionId,
          resolve,
          reject,
          cleanup: () => {
            if (timer) clearTimeout(timer)
            options.signal?.removeEventListener('abort', onAbort)
          },
        })
        sink.emit({ requestId, panelId, op, ...(args !== undefined ? { args } : {}) })
      })
    },
    capability: () => ({
      requests: (_params, sink, ctx) => attach(ctx.connection, sink),
      reply: ({ requestId, result, error }, ctx) => {
        // Only the client that was asked may answer.
        if (pending.get(requestId)?.connectionId !== ctx.connection.id) return
        settle(requestId, error ? { error: fromWireError(error as WireError) } : { result })
      },
    }),
    dispose() {
      for (const requestId of [...pending.keys()]) settle(requestId, { error: new RpcError('no-renderer', 'the runtime is stopping') })
      drivers.clear()
    },
  }
}
