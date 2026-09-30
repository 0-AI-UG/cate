// kernel/lifecycle: a bus for shutdown and client presence, so generic
// lifecycle code never names a feature (architecture 6). Pure: the bus holds
// listeners only. The daemon's instance is in ./runtime.

import type { ClientFeature, DeviceInfo } from '@kernel/rpc/contract'

/** A client connection as the runtime sees it. A client that reconnects is a
 *  new connection with the same `clientId`. */
export interface ClientConnection {
  connectionId: number
  clientId: string
  device: DeviceInfo
  features: readonly ClientFeature[]
}

type Unsubscribe = () => void

export interface LifecycleBus {
  onShutdown(listener: (reason: string) => void | Promise<void>): Unsubscribe
  onClientConnected(listener: (client: ClientConnection) => void): Unsubscribe
  onClientGone(listener: (client: ClientConnection) => void): Unsubscribe
  /** Runs every shutdown listener and waits for all of them. A failing
   *  listener does not stop the others. */
  emitShutdown(reason: string): Promise<void>
  emitClientConnected(client: ClientConnection): void
  emitClientGone(client: ClientConnection): void
}

export function createLifecycleBus(onListenerError: (err: unknown) => void = () => {}): LifecycleBus {
  const shutdown = new Set<(reason: string) => void | Promise<void>>()
  const connected = new Set<(client: ClientConnection) => void>()
  const gone = new Set<(client: ClientConnection) => void>()

  const add = <T>(set: Set<T>, listener: T): Unsubscribe => {
    set.add(listener)
    return () => { set.delete(listener) }
  }
  const emit = (set: Set<(client: ClientConnection) => void>, client: ClientConnection) => {
    for (const listener of [...set]) {
      try { listener(client) } catch (err) { onListenerError(err) }
    }
  }

  return {
    onShutdown: (listener) => add(shutdown, listener),
    onClientConnected: (listener) => add(connected, listener),
    onClientGone: (listener) => add(gone, listener),
    async emitShutdown(reason) {
      const results = await Promise.allSettled([...shutdown].map(async (listener) => listener(reason)))
      for (const r of results) if (r.status === 'rejected') onListenerError(r.reason)
    },
    emitClientConnected: (client) => emit(connected, client),
    emitClientGone: (client) => emit(gone, client),
  }
}
