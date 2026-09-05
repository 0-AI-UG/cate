import { app, ipcMain, powerSaveBlocker } from 'electron'
import { KEEP_AWAKE_GET, KEEP_AWAKE_SET, KEEP_AWAKE_CHANGED } from '../../shared/ipc-channels'
import { broadcastToAll } from '../windowRegistry'

export function registerKeepAwakeHandlers(): void {
  // App-wide and session-only: one blocker shared by every Cate window.
  let blockerId: number | undefined
  const isEnabled = () => blockerId !== undefined && powerSaveBlocker.isStarted(blockerId)
  const stop = () => {
    if (blockerId !== undefined) powerSaveBlocker.stop(blockerId)
    blockerId = undefined
  }

  ipcMain.handle(KEEP_AWAKE_GET, () => isEnabled())
  ipcMain.handle(KEEP_AWAKE_SET, (_event, enabled: boolean) => {
    if (typeof enabled !== 'boolean') throw new TypeError('Expected a boolean')
    if (enabled) {
      if (!isEnabled()) blockerId = powerSaveBlocker.start('prevent-app-suspension')
    } else {
      stop()
    }
    const active = isEnabled()
    broadcastToAll(KEEP_AWAKE_CHANGED, active)
    return active
  })

  app.on('will-quit', stop)
}
