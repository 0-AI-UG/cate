import { listDockWindows, sendToWindow } from '../windowRegistry'
import { stopTerminalsForRenderer } from '../ipc/terminal'
import { stopWatchersForWindow } from '../ipc/filesystem'
import { stopSearchesForWindow } from '../ipc/search'
import { stopMonitorsForWindow } from '../ipc/git-monitor'
import { DOCK_WINDOW_INIT } from '../../shared/ipc-channels'
import { BrowserWindow, dialog } from 'electron'
import log from '../logger'
import { captureMainMessage } from '../sentry'

// =============================================================================
// Renderer crash recovery.
//
// A renderer process can die from OOM, a GPU fault, or a native crash that
// produces no JS stack — none of which React's ErrorBoundary can catch. Without
// handling, the window simply goes blank and the user is stuck. We auto-reload
// on the first crash (cheap, usually recovers a transient GPU/OOM blip) and fall
// back to an explicit dialog if a window crash-loops, so we never spin forever.
// =============================================================================

const CRASH_RELOAD_WINDOW_MS = 30_000
const MAX_RELOADS_IN_WINDOW = 3
let unresponsiveDialogOpen = false

async function showCrashLoopDialog(win: BrowserWindow, windowType: string, reason: string): Promise<void> {
  if (win.isDestroyed()) return
  let response = 0
  try {
    ;({ response } = await dialog.showMessageBox(win, {
      type: 'error',
      title: 'A window keeps crashing',
      message: 'This window’s display process exited unexpectedly several times.',
      detail: `Reason: ${reason}. Auto-reloading hasn’t recovered it. You can try once more, or close the window. Your other windows and saved work are unaffected.`,
      buttons: ['Reload', 'Close Window'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }))
  } catch { /* dialog failed — leave the window as-is */ return }
  if (win.isDestroyed()) return
  if (response === 0) {
    try { win.webContents.reload() } catch { /* noop */ }
  } else {
    try { win.close() } catch { /* noop */ }
  }
}

async function showUnresponsiveDialog(win: BrowserWindow): Promise<void> {
  if (unresponsiveDialogOpen || win.isDestroyed()) return
  unresponsiveDialogOpen = true
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Cate is not responding',
      message: 'This window has become unresponsive.',
      detail: 'You can keep waiting in case it recovers, or force it to reload. Reloading discards any in-progress, unsaved work in this window.',
      buttons: ['Keep Waiting', 'Reload'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    if (!win.isDestroyed() && response === 1) {
      // forcefullyCrashRenderer kills a truly-hung renderer that a plain
      // reload() can't preempt; render-process-gone then auto-reloads it.
      try { win.webContents.forcefullyCrashRenderer() } catch { /* noop */ }
    }
  } catch { /* noop */ } finally {
    unresponsiveDialogOpen = false
  }
}

export function installRendererCrashRecovery(win: BrowserWindow, windowType: string, windowId: number): void {
  let reloads: number[] = []
  let loaded = false
  let replacing = false
  let dockSnapshot: ReturnType<typeof listDockWindows>[number] | undefined
  const retireRenderer = (): void => {
    if (replacing) return
    replacing = true
    dockSnapshot = windowType === 'dock' ? listDockWindows().find(snapshot => snapshot.windowId === windowId) : undefined
    stopTerminalsForRenderer(windowId)
    stopWatchersForWindow(windowId)
    stopSearchesForWindow(windowId)
    stopMonitorsForWindow(windowId)
  }
  win.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (loaded && mainFrame && !inPlace) retireRenderer()
  })
  win.webContents.on('did-finish-load', () => {
    loaded = true
    if (!replacing) return
    replacing = false
    if (dockSnapshot) {
      sendToWindow(windowId, DOCK_WINDOW_INIT, {
        workspaceId: dockSnapshot.workspaceId,
        rootPath: dockSnapshot.rootPath,
        worktrees: dockSnapshot.worktrees,
        panels: dockSnapshot.panels,
        dockState: dockSnapshot.dockState.zones,
        canvasStates: dockSnapshot.canvasStates,
        terminalCwds: dockSnapshot.terminalCwds,
        restore: true,
      })
      dockSnapshot = undefined
    }
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    // 'clean-exit' is a normal teardown (the window is closing) — not a crash.
    if (details.reason === 'clean-exit') return
    retireRenderer()
    log.error(
      '[crash] renderer gone window=%d type=%s reason=%s exitCode=%s',
      windowId, windowType, details.reason, String(details.exitCode),
    )
    captureMainMessage('renderer-process-gone', {
      reason: details.reason,
      exitCode: details.exitCode,
      windowType,
    })
    if (win.isDestroyed()) return

    const now = Date.now()
    reloads = reloads.filter((t) => now - t < CRASH_RELOAD_WINDOW_MS)
    if (reloads.length >= MAX_RELOADS_IN_WINDOW) {
      reloads = []
      void showCrashLoopDialog(win, windowType, details.reason)
      return
    }
    reloads.push(now)
    log.info('[crash] auto-reloading window=%d (attempt %d/%d)', windowId, reloads.length, MAX_RELOADS_IN_WINDOW)
    try { win.webContents.reload() } catch (err) {
      log.warn('[crash] reload failed: %s', err instanceof Error ? err.message : String(err))
    }
  })

  win.on('unresponsive', () => {
    log.warn('[crash] window unresponsive window=%d type=%s', windowId, windowType)
    captureMainMessage('renderer-unresponsive', { windowType })
    void showUnresponsiveDialog(win)
  })
  win.on('responsive', () => {
    log.info('[crash] window responsive again window=%d', windowId)
  })
}
