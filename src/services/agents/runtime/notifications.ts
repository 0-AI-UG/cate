import type { AgentNotificationEvent } from '../contract'

/** Agent notification events (architecture 10.5). Clients subscribe through
 *  the `agents.notifications` stream and decide whether to show each one. */
export interface AgentNotifications {
  publish(event: AgentNotificationEvent): void
  subscribe(listener: (event: AgentNotificationEvent) => void): () => void
}

export function createAgentNotifications(): AgentNotifications {
  const listeners = new Set<(event: AgentNotificationEvent) => void>()
  return {
    publish(event) {
      for (const listener of listeners) {
        try { listener(event) } catch { /* one subscriber must not stop the rest */ }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
