// How every client consumes notification events (architecture 10.5): one
// subscription to the `notifications` stream per open workspace, each event
// handed to the shell's display.

import type { Subscription, SubscribeOptions } from '@kernel/rpc/contract'
import type { NotificationEvent } from '../contract'

/** The part of a workspace connection this needs. */
export interface NotificationConnection {
  readonly workspaceId: string
  readonly runtime: {
    notifications: { events(params?: undefined, opts?: SubscribeOptions): Subscription<NotificationEvent, unknown> }
  }
}

export interface NotificationConnections {
  getSnapshot(): readonly NotificationConnection[]
  subscribe(listener: () => void): () => void
}

/** Keeps one subscription per open connection; `show` gets every event. */
export function attachNotifications(
  connections: NotificationConnections,
  show: (workspaceId: string, event: NotificationEvent) => void,
): () => void {
  const attached = new Map<NotificationConnection, () => void>()
  const attachOne = (connection: NotificationConnection) => {
    const events = connection.runtime.notifications.events(undefined, { resume: true })
    const off = events.onEvent((event) => show(connection.workspaceId, event))
    events.done.catch(() => {})
    return () => {
      off()
      events.cancel()
    }
  }
  const sync = () => {
    const current = new Set(connections.getSnapshot())
    for (const [connection, detach] of attached) {
      if (current.has(connection)) continue
      attached.delete(connection)
      detach()
    }
    for (const connection of current) {
      if (!attached.has(connection)) attached.set(connection, attachOne(connection))
    }
  }
  const stop = connections.subscribe(sync)
  sync()
  return () => {
    stop()
    for (const detach of attached.values()) detach()
    attached.clear()
  }
}
