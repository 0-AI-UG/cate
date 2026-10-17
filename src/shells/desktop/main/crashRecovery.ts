// Renderer crash recovery. A renderer can die from OOM, a GPU fault or a
// native crash that no error boundary sees. The first crashes reload the
// window (the document lives in the runtime, so a reload loses only client
// state); a window that keeps crashing gets a dialog instead of a reload loop.

import type { BrowserWindow, MessageBoxOptions } from 'electron'
import { createLogger } from '@kernel/log/contract'

const log = createLogger('crash')

const CRASH_RELOAD_WINDOW_MS = 30_000
export const MAX_RELOADS_IN_WINDOW = 3

export interface CrashRecoveryDeps {
  showMessageBox(win: BrowserWindow, options: MessageBoxOptions): Promise<{ response: number }>
  report(message: string, extra: Record<string, unknown>): void
  now?: () => number
}

type CrashWindow = Pick<BrowserWindow, 'isDestroyed' | 'close' | 'on'> & {
  webContents: Pick<BrowserWindow['webContents'], 'reload' | 'forcefullyCrashRenderer' | 'on'>
}

export function installCrashRecovery(win: CrashWindow, kind: string, deps: CrashRecoveryDeps): void {
  const now = deps.now ?? Date.now
  let reloads: number[] = []
  let unresponsiveOpen = false

  const crashLoopDialog = async (reason: string) => {
    let response = 1
    try {
      ;({ response } = await deps.showMessageBox(win as BrowserWindow, {
        type: 'error',
        title: 'A window keeps crashing',
        message: 'This window’s display process exited unexpectedly several times.',
        detail: `Reason: ${reason}. Reloading has not recovered it. You can try once more, or close the window. Your workspaces keep running.`,
        buttons: ['Reload', 'Close Window'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      }))
    } catch { return }
    if (win.isDestroyed()) return
    try {
      if (response === 0) win.webContents.reload()
      else win.close()
    } catch { /* window went away */ }
  }

  win.webContents.on('render-process-gone', (_event, details) => {
    // A clean exit is a closing window, not a crash.
    if (details.reason === 'clean-exit') return
    log.error('renderer gone kind=%s reason=%s exitCode=%s', kind, details.reason, String(details.exitCode))
    deps.report('renderer-process-gone', { reason: details.reason, exitCode: details.exitCode, windowKind: kind })
    if (win.isDestroyed()) return
    const at = now()
    reloads = reloads.filter((t) => at - t < CRASH_RELOAD_WINDOW_MS)
    if (reloads.length >= MAX_RELOADS_IN_WINDOW) {
      reloads = []
      void crashLoopDialog(details.reason)
      return
    }
    reloads.push(at)
    log.info('reloading crashed window (attempt %d/%d)', reloads.length, MAX_RELOADS_IN_WINDOW)
    try { win.webContents.reload() } catch (error) { log.warn('reload failed: %O', error) }
  })

  win.on('unresponsive', () => {
    log.warn('window unresponsive kind=%s', kind)
    deps.report('renderer-unresponsive', { windowKind: kind })
    if (unresponsiveOpen || win.isDestroyed()) return
    unresponsiveOpen = true
    void deps.showMessageBox(win as BrowserWindow, {
      type: 'warning',
      title: 'Cate is not responding',
      message: 'This window has become unresponsive.',
      detail: 'You can keep waiting in case it recovers, or reload it.',
      buttons: ['Keep Waiting', 'Reload'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }).then(({ response }) => {
      // A hung renderer cannot be preempted by reload(); crash it and let the
      // handler above reload it.
      if (response === 1 && !win.isDestroyed()) win.webContents.forcefullyCrashRenderer()
    }, () => {}).finally(() => { unresponsiveOpen = false })
  })
}
