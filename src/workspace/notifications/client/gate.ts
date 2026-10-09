// What a client shows of the events it gets: each waits a moment for a newer
// one (or a cancel, when the agent went back to work), then shows when this
// client's settings and focus allow. Every shell gives it its own `show`.

import { shouldShowNotification, type NotificationEvent, type NotificationSettings } from '../contract'
import { createNotificationDebouncer } from './debouncer'

export const NOTIFICATION_DEBOUNCE_MS = 300

export interface NotificationGateDeps {
  /** The client's notification settings (the shared client slice). */
  settings(): NotificationSettings
  /** Whether this client has the person's attention. */
  isFocused(): boolean
  /** Shows one event, the shell's way. */
  show(workspaceId: string, event: NotificationEvent): void
  /** How long an event waits for a newer one or a cancel. */
  debounceMs?: number
}

export interface NotificationGate {
  show(workspaceId: string, event: NotificationEvent): void
  /** What the panel asked for is answered: a pending event for it goes. */
  cancel(workspaceId: string, panelId: string): void
  dispose(): void
}

const keyOf = (workspaceId: string, event: { panelId?: string; kind: string }) =>
  `${workspaceId}\0${event.panelId ?? `kind:${event.kind}`}`

export function createNotificationGate(deps: NotificationGateDeps): NotificationGate {
  const debouncer = createNotificationDebouncer(deps.debounceMs ?? NOTIFICATION_DEBOUNCE_MS, ({ workspaceId, event }: { workspaceId: string; event: NotificationEvent }) => {
    if (shouldShowNotification(deps.settings(), deps.isFocused())) deps.show(workspaceId, event)
  })
  return {
    show: (workspaceId, event) => debouncer.request(keyOf(workspaceId, event), { workspaceId, event }),
    cancel: (workspaceId, panelId) => debouncer.cancel(keyOf(workspaceId, { panelId, kind: '' })),
    dispose: () => debouncer.dispose(),
  }
}
