// =============================================================================
// Send an OS notification — settings-gated dispatch only.
//
// Kept free of the heavy click-handling graph (terminalRegistry / appStore /
// dockStore) that lives in osNotifications.ts, so modules that only need to
// *send* (e.g. the agent activity coordinator) can import this without pulling
// in xterm and the full store graph. Click-action handling stays in
// osNotifications.ts.
// =============================================================================

import { useSettingsStore } from '../stores/settingsStore'
import { shouldSendNotification } from './notificationGating'
import type { NotificationAction } from '../../shared/types'

export function sendOsNotification(payload: {
  title: string
  body: string
  action?: NotificationAction
}): void {
  const settings = useSettingsStore.getState()
  const focused = typeof document !== 'undefined' && document.hasFocus()
  if (!shouldSendNotification(settings, focused)) return
  window.electronAPI?.notifyOS(payload)
}
