// The workspace's notification events (architecture 10.5): publishers call
// `publish`, clients follow the `notifications` capability's stream, and the
// composition root hands them to push delivery.

import type { CapabilityImpl } from '@kernel/rpc/runtime'
import type { NotificationEvent, notificationsCapability } from '../contract'

export interface Notifications {
  publish(event: NotificationEvent): void
  /** Publishes an event that also goes to every client that connects later
   *  (a warning raised before anyone was there, such as a quarantined file). */
  keep(event: NotificationEvent): void
  /** The kept events, oldest first. */
  kept(): readonly NotificationEvent[]
  subscribe(listener: (event: NotificationEvent) => void): () => void
}

/** Kept events beyond this drop the oldest. */
const KEPT_LIMIT = 20

export function createNotifications(): Notifications {
  const listeners = new Set<(event: NotificationEvent) => void>()
  const kept: NotificationEvent[] = []
  const publish = (event: NotificationEvent) => {
    for (const listener of [...listeners]) {
      try { listener(event) } catch { /* one subscriber must not stop the rest */ }
    }
  }
  return {
    publish,
    keep(event) {
      kept.push(event)
      if (kept.length > KEPT_LIMIT) kept.shift()
      publish(event)
    },
    kept: () => kept,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

export function notificationsCapabilityImpl(notifications: Notifications): CapabilityImpl<typeof notificationsCapability> {
  return {
    events(_params, sink) {
      for (const event of notifications.kept()) sink.emit(event)
      return notifications.subscribe((event) => sink.emit(event))
    },
  }
}
