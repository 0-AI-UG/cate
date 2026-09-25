import { app, ipcMain, powerSaveBlocker } from 'electron'
import { KEEP_AWAKE_TOGGLE, KEEP_AWAKE_GET, KEEP_AWAKE_SET, KEEP_AWAKE_CHANGED } from '../../shared/ipc-channels'
import { broadcastToAll } from '../windowRegistry'
import type { KeepAwakeState } from '../../shared/keepAwake'

export function registerKeepAwakeHandlers(): void {
  // App-wide and session-only: one blocker shared by every Cate window.
  let blockerId: number | undefined
  let endsAt: number | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const isEnabled = () => blockerId !== undefined && powerSaveBlocker.isStarted(blockerId)
  const state = (): KeepAwakeState => ({ enabled: isEnabled(), endsAt: isEnabled() ? endsAt : null })
  const stop = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (blockerId !== undefined) powerSaveBlocker.stop(blockerId)
    blockerId = undefined
    endsAt = null
  }

  const publish = () => {
    const current = state()
    broadcastToAll(KEEP_AWAKE_CHANGED, current)
    return current
  }
  ipcMain.handle(KEEP_AWAKE_GET, state)
  const setDuration = (durationMinutes: 30 | 60 | 300 | null | false) => {
    if (durationMinutes !== false && durationMinutes !== null && ![30, 60, 300].includes(durationMinutes)) {
      throw new TypeError('Expected a keep-awake duration')
    }
    if (durationMinutes !== false) {
      if (!isEnabled()) blockerId = powerSaveBlocker.start('prevent-display-sleep')
      if (timer) clearTimeout(timer)
      endsAt = durationMinutes === null ? null : Date.now() + durationMinutes * 60_000
      if (endsAt !== null) {
        timer = setTimeout(() => { stop(); publish() }, endsAt - Date.now())
      } else {
        timer = undefined
      }
    } else {
      stop()
    }
    return publish()
  }
  ipcMain.handle(KEEP_AWAKE_SET, (_event, duration: 30 | 60 | 300 | null | false) => setDuration(duration))
  ipcMain.handle(KEEP_AWAKE_TOGGLE, () => setDuration(isEnabled() ? false : null))

  app.on('will-quit', stop)
}
