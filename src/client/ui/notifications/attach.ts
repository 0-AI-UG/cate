// Subscribes to the notification events of every open workspace and hands
// them to the display. A pending agent notification is dropped when that
// agent goes back to work.

import type { Subscription, SubscribeOptions } from '@kernel/rpc/contract'
import { acquireAgentPanels } from '@services/agents/client'
import type { NotificationDisplay, RuntimeNotification } from './display'

/** The part of a workspace connection this needs. */
export interface NotificationConnection {
  readonly workspaceId: string
  readonly runtime: {
    agents: { notifications(params?: undefined, opts?: SubscribeOptions): Subscription<RuntimeNotification, unknown> }
  }
}

export interface NotificationConnections {
  getSnapshot(): readonly NotificationConnection[]
  subscribe(listener: () => void): () => void
}

function attachOne(connection: NotificationConnection, display: NotificationDisplay): () => void {
  const { workspaceId } = connection
  const events = connection.runtime.agents.notifications(undefined, { resume: true })
  const offEvents = events.onEvent((event) => display.show(workspaceId, event))
  events.done.catch(() => {})
  const panels = acquireAgentPanels(workspaceId)
  const offPanels = panels.subscribe(() => {
    for (const [panelId, state] of Object.entries(panels.getSnapshot())) {
      if (state.status === 'running') display.cancel(workspaceId, panelId)
    }
  })
  return () => {
    offEvents()
    events.cancel()
    offPanels()
    panels.release()
  }
}

/** Keeps one notification subscription per open connection. */
export function attachNotifications(connections: NotificationConnections, display: NotificationDisplay): () => void {
  const attached = new Map<NotificationConnection, () => void>()
  const sync = () => {
    const current = new Set(connections.getSnapshot())
    for (const [connection, detach] of attached) {
      if (current.has(connection)) continue
      attached.delete(connection)
      detach()
    }
    for (const connection of current) {
      if (!attached.has(connection)) attached.set(connection, attachOne(connection, display))
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
