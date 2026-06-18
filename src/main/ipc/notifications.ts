// =============================================================================
// Notification IPC handlers — OS-level notifications via Electron Notification API
// =============================================================================

import { ipcMain, Notification, app } from 'electron'
import { NOTIFY_OS, NOTIFY_ACTION } from '../../shared/ipc-channels'
import { sendToWindow, windowFromEvent, focusWindow } from '../windowRegistry'
import type { NotificationAction } from '../../shared/types'

// Hold a strong reference to every shown notification until it resolves.
// Without this the Notification is GC'd once the IPC handler returns, and on
// some platforms (notably macOS) its 'click' event then never fires — the OS
// banner still shows, but clicking it is dead. Released on click/close/failed.
const liveNotifications = new Set<Notification>()

/**
 * Show one OS notification with the GC-reference guard (above) and the macOS
 * dock bounce, the single place that talks to Electron's Notification API.
 * Shared by the NOTIFY_OS IPC handler and the extension `cate.ui.notify` reverse
 * call so both behave identically (and neither re-introduces the click GC bug).
 */
export function showOsNotification(opts: {
  title: string
  body: string
  onClick?: () => void
}): void {
  if (Notification.isSupported()) {
    const notification = new Notification({ title: opts.title, body: opts.body })
    liveNotifications.add(notification)
    const release = (): void => { liveNotifications.delete(notification) }
    notification.on('click', () => { opts.onClick?.(); release() })
    notification.on('close', release)
    notification.on('failed', release)
    notification.show()
  }
  // Dock bounce on macOS (independent of banner support).
  if (process.platform === 'darwin') {
    app.dock?.bounce('informational')
  }
}

export function registerHandlers(): void {
  ipcMain.handle(
    NOTIFY_OS,
    async (
      event,
      payload: { title: string; body: string; action?: NotificationAction },
    ) => {
      const win = windowFromEvent(event)
      const ownerWindowId = win?.id ?? -1

      showOsNotification({
        title: payload.title,
        body: payload.body,
        onClick: () => {
          // Focus the owning window, then hand the action back to its renderer.
          if (win && !win.isDestroyed()) focusWindow(win)
          if (payload.action) sendToWindow(ownerWindowId, NOTIFY_ACTION, payload.action)
        },
      })
    },
  )
}
