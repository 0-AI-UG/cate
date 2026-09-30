// Shows runtime notification events on this client (architecture 10.5, 12.2
// rule 7): gated by the client's notification settings and focus, then an OS
// notification through `clientUi().notify` when the client has
// `osNotifications`, else an in-app toast. Clicking one focuses its panel.

import { clientHas } from '@client/connections'
import { clientStateFor, documentStoreFor } from '@client/document'
import { clientUi } from '@kernel/ui'
import type { NotificationAction } from '@kernel/ui/contract'
import { placementOf } from '@workspace/document/contract'
import { createNotificationDebouncer } from './debouncer'
import { shouldShowNotification, type NotificationSettings } from './gating'
import { toasts as defaultToasts, type ToastStore } from './toasts'

/** A notification event a runtime service published: an agent needs input
 *  or permission, a command failed, `cate.ui.notify`. */
export interface RuntimeNotification {
  kind: string
  panelId?: string
  title: string
  body: string
  level?: 'info' | 'warning' | 'error'
}

const focusListeners = new Set<(workspaceId: string, panelId: string) => void>()

/** Called when a notification click focuses a panel, so the layout can bring
 *  its workspace and window forward. */
export function onNotificationFocus(listener: (workspaceId: string, panelId: string) => void): () => void {
  focusListeners.add(listener)
  return () => { focusListeners.delete(listener) }
}

/** Runs a notification's click action: focuses its panel (client state).
 *  The shell calls it when an OS notification is clicked. */
export function runNotificationAction(action: NotificationAction): void {
  const { workspaceId } = action
  const panelId = action.type === 'focusPanel' ? action.panelId : action.terminalId
  const state = clientStateFor(workspaceId)
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  if (!state || !doc?.panels[panelId]) return
  const placed = placementOf(doc, panelId)
  if (placed) state.setActiveTab(placed.stackId, panelId)
  state.focus(panelId)
  for (const listener of [...focusListeners]) {
    try { listener(workspaceId, panelId) } catch { /* isolate listeners */ }
  }
}

export interface NotificationDisplayDeps {
  /** The client's notification settings (client settings slice). */
  settings(): NotificationSettings
  /** Whether this client has the person's attention. */
  isFocused?(): boolean
  /** Whether to use OS notifications; defaults to the client feature plus an
   *  installed `clientUi().notify`. */
  osNotifications?(): boolean
  toasts?: ToastStore
  /** How long an event waits for a newer one or a cancel. */
  debounceMs?: number
}

export interface NotificationDisplay {
  show(workspaceId: string, event: RuntimeNotification): void
  /** Drops a pending notification of a panel. */
  cancel(workspaceId: string, panelId: string): void
  dispose(): void
}

export const NOTIFICATION_DEBOUNCE_MS = 300

const keyOf = (workspaceId: string, event: { panelId?: string; kind: string }) =>
  `${workspaceId}\0${event.panelId ?? `kind:${event.kind}`}`

export function createNotificationDisplay(deps: NotificationDisplayDeps): NotificationDisplay {
  const isFocused = deps.isFocused ?? (() => typeof document !== 'undefined' && document.hasFocus())
  const osNotifications = deps.osNotifications ?? (() => clientHas('osNotifications') && !!clientUi().notify)
  const toasts = deps.toasts ?? defaultToasts

  const fire = ({ workspaceId, event }: { workspaceId: string; event: RuntimeNotification }) => {
    if (!shouldShowNotification(deps.settings(), isFocused())) return
    const action: NotificationAction | undefined = event.panelId
      ? { type: 'focusPanel', workspaceId, panelId: event.panelId }
      : undefined
    if (osNotifications()) {
      clientUi().notify?.({ title: event.title, body: event.body, ...(action ? { action } : {}) })
      return
    }
    toasts.show({
      title: event.title,
      body: event.body,
      ...(event.level ? { level: event.level } : {}),
      ...(action ? { onClick: () => runNotificationAction(action) } : {}),
    })
  }

  const debouncer = createNotificationDebouncer(deps.debounceMs ?? NOTIFICATION_DEBOUNCE_MS, fire)
  return {
    show: (workspaceId, event) => debouncer.request(keyOf(workspaceId, event), { workspaceId, event }),
    cancel: (workspaceId, panelId) => debouncer.cancel(keyOf(workspaceId, { panelId, kind: '' })),
    dispose: () => debouncer.dispose(),
  }
}
