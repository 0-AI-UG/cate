// The desktop's display for the shared notification consumer
// (`attachNotifications`, architecture 10.5, 12.2 rule 7): through the core's
// gate (the client's notification settings and focus), each event becomes an
// OS notification through `clientUi().notify` when the client has
// `osNotifications`, else an in-app toast. Clicking one focuses its panel.

import { clientStateFor, documentStoreFor } from '@client/document'
import { clientUi } from '@kernel/interaction'
import type { NotificationAction } from '@kernel/interaction/contract'
import { placementOf } from '@workspace/document/contract'
import { createNotificationGate, type NotificationGate, type NotificationSettingsReader } from '@workspace/notifications/client'
import type { NotificationEvent } from '@workspace/notifications/contract'
import { toasts as defaultToasts, type ToastStore } from './toasts'

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
  /** The client's settings store. */
  settings: NotificationSettingsReader
  /** Whether this client has the person's attention. */
  isFocused?(): boolean
  /** Whether to use OS notifications; defaults to the client feature plus an
   *  installed `clientUi().notify`. */
  osNotifications?(): boolean
  toasts?: ToastStore
  /** How long an event waits for a newer one or a cancel. */
  debounceMs?: number
}

export function createNotificationDisplay(deps: NotificationDisplayDeps): NotificationGate {
  const isFocused = deps.isFocused ?? (() => typeof document !== 'undefined' && document.hasFocus())
  const osNotifications = deps.osNotifications ?? (() => !!clientUi().notify)
  const toasts = deps.toasts ?? defaultToasts

  const show = (workspaceId: string, event: NotificationEvent) => {
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
      ...('level' in event && event.level ? { level: event.level } : {}),
      ...(action ? { onClick: () => runNotificationAction(action) } : {}),
    })
  }

  return createNotificationGate({ settings: deps.settings, isFocused, show, ...(deps.debounceMs !== undefined ? { debounceMs: deps.debounceMs } : {}) })
}
