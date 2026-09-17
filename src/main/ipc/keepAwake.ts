import { app, ipcMain, powerSaveBlocker } from 'electron'
import { KEEP_AWAKE_TOGGLE, KEEP_AWAKE_GET, KEEP_AWAKE_STATUS, KEEP_AWAKE_SET, KEEP_AWAKE_CHANGED } from '../../shared/ipc-channels'
import { broadcastToAll } from '../windowRegistry'

export function registerKeepAwakeHandlers(): void {
  // App-wide and session-only: one blocker shared by every Cate window.
  let blockerId: number | undefined
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  let endsAt: number | null = null
  const isEnabled = () => blockerId !== undefined && powerSaveBlocker.isStarted(blockerId)
  const status = () => ({ enabled: isEnabled(), endsAt: isEnabled() ? endsAt : null })
  const stop = () => {
    if (expiryTimer) clearTimeout(expiryTimer)
    expiryTimer = undefined
    endsAt = null
    if (blockerId !== undefined) powerSaveBlocker.stop(blockerId)
    blockerId = undefined
  }

  ipcMain.handle(KEEP_AWAKE_GET, () => isEnabled())
  ipcMain.handle(KEEP_AWAKE_STATUS, status)
  const setEnabled = (enabled: boolean, minutes?: number) => {
    if (typeof enabled !== 'boolean') throw new TypeError('Expected a boolean')
    if (minutes !== undefined && (!enabled || ![15, 30, 45, 60].includes(minutes))) {
      throw new TypeError('Expected a keep-awake duration of 15, 30, 45, or 60 minutes')
    }
    if (enabled) {
      if (!isEnabled()) blockerId = powerSaveBlocker.start('prevent-display-sleep')
      if (expiryTimer) clearTimeout(expiryTimer)
      endsAt = minutes === undefined ? null : Date.now() + minutes * 60_000
      expiryTimer = minutes === undefined ? undefined : setTimeout(() => setEnabled(false), minutes * 60_000)
    } else {
      stop()
    }
    const active = isEnabled()
    broadcastToAll(KEEP_AWAKE_CHANGED, active, active ? endsAt : null)
    return active
  }
  ipcMain.handle(KEEP_AWAKE_SET, (_event, enabled: boolean, minutes?: number) => setEnabled(enabled, minutes))
  ipcMain.handle(KEEP_AWAKE_TOGGLE, () => setEnabled(!isEnabled()))

  app.on('will-quit', stop)
}
