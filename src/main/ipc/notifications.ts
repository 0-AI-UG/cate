// =============================================================================
// Notification IPC handlers — OS-level notifications via Electron Notification API
// =============================================================================

import { ipcMain, Notification, app } from 'electron'
import { NOTIFY_OS, NOTIFY_ACTION } from '../../shared/ipc-channels'
import { sendToWindow, windowFromEvent, focusWindow } from '../windowRegistry'
import type { NotificationAction } from '../../shared/types'

export function registerHandlers(): void {
  ipcMain.handle(
    NOTIFY_OS,
    async (
      event,
      payload: { title: string; body: string; action?: NotificationAction },
    ) => {
      const win = windowFromEvent(event)
      const ownerWindowId = win?.id ?? -1

      if (Notification.isSupported()) {
        const notification = new Notification({
          title: payload.title,
          body: payload.body,
        })

        notification.on('click', () => {
          // Focus the owning window
          if (win && !win.isDestroyed()) {
            focusWindow(win)
          }

          // Send the action back to the renderer so it can execute it
          if (payload.action) {
            sendToWindow(ownerWindowId, NOTIFY_ACTION, payload.action)
          }
        })

        notification.show()
      }

      // Dock bounce on macOS
      if (process.platform === 'darwin') {
        app.dock?.bounce('informational')
      }
    },
  )
}
