import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import log from '../logger'
import { createWindow } from '../windows/windowFactory'
import { setMainWindowReady, flushPendingOpenPaths } from './openPath'
import { getActiveMainWindow, sendToWindow, listDockWindowIds } from '../windowRegistry'
import { flushDockWindowsBeforeQuit } from '../dockWindowFlush'
import { flushAllLoggers, killAllTerminals } from '../ipc/terminal'
import { getRunningTerminals } from '../ipc/shell'
import { getSetting } from '../settingsFile'
import { saveProjectStateSync } from '../projectWorkspaceStore'
import { flushPendingWritesSync as flushSettingsPendingWritesSync } from '../settingsFile'
import { flushWorkspaceStateSync } from '../workspaceStateStore'
import { flushBrowserStateSync } from '../browserStateStore'
import { flushUIStateSync } from '../uiStateStore'
import { releaseAllProjectLocks } from '../projectLock'
import { runtimes } from '../runtime/runtimeManager'
import { isUpdatePendingInstall } from '../auto-updater'
import {
  SESSION_FLUSH_SAVE,
  SESSION_FLUSH_SAVE_DONE,
  DOCK_WINDOW_FLUSH_SYNC,
  DOCK_WINDOW_FLUSH_SYNC_DONE,
} from '../../shared/ipc-channels'

// ---------------------------------------------------------------------------
// Quit coordination — the renderer needs live PTYs to capture terminal CWD
// and scrollback, so we defer PTY teardown until the renderer confirms the
// session save is complete. Flow:
//   1. before-quit: flush loggers, send SESSION_FLUSH_SAVE to renderer, defer quit
//   2. renderer saves session (async — needs live PTYs for CWD/scrollback)
//   3. renderer sends SESSION_FLUSH_SAVE_DONE
//   4. main process re-triggers app.quit()
//   5. before-quit fires again (sessionFlushed = true, falls through)
//   6. will-quit: sync fallback save, kill PTYs, _exit(0)
// ---------------------------------------------------------------------------

let sessionFlushed = false
// Set once the user has confirmed (or there was nothing to confirm) that it's OK
// to quit while terminals are still running a foreground process. Gates the
// flush/quit sequence below so the confirmation only runs on the first pass.
let quitConfirmed = false
const FLUSH_TIMEOUT_MS = 1500
// Bound the pre-quit dock-window sync so an unresponsive detached window can't
// stall quit. Kept short relative to FLUSH_TIMEOUT_MS — it runs BEFORE the main
// renderer's session flush, so dock sync + session save share the quit budget.
const DOCK_FLUSH_TIMEOUT_MS = 600

/** A confirmation dialog to show before quitting, or null to quit immediately.
 *  Two independent reasons gate quit: terminals still running a foreground
 *  process (data-loss warning, takes precedence so its specific message wins),
 *  and the user's "Warn before quit" preference (a plain confirmation). */
export function decideQuitPrompt(opts: {
  warnBeforeQuit: boolean
  running: Array<{ processName: string | null }>
}): { message: string; detail?: string } | null {
  const count = opts.running.length
  if (count > 0) {
    const name = count === 1 ? opts.running[0].processName?.trim() : undefined
    return {
      message:
        count > 1
          ? `${count} terminals are still running. Quit anyway?`
          : name
            ? `“${name}” is still running. Quit anyway?`
            : 'A terminal is still running. Quit anyway?',
      detail:
        count > 1
          ? 'The processes running in these terminals will be terminated.'
          : 'The process running in this terminal will be terminated.',
    }
  }
  if (opts.warnBeforeQuit) {
    return { message: 'Quit Cate?' }
  }
  return null
}

/**
 * Wire the app-lifecycle event handlers: window-all-closed, activate, and the
 * before-quit / will-quit / quit teardown sequence. Called once from the index
 * bootstrap.
 */
export function registerLifecycleHandlers(): void {
  app.on('window-all-closed', () => {
    log.info('All windows closed, quitting')
    app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      setMainWindowReady(false)
      const win = createWindow({ type: 'main' })
      win.once('ready-to-show', () => {
        setMainWindowReady(true)
        flushPendingOpenPaths()
      })
    }
  })

  app.on('before-quit', (event) => {
    if (sessionFlushed) {
      // Second pass — renderer already saved, let quit proceed to will-quit
      log.info('before-quit: session already flushed, proceeding')
      return
    }

    // First gate: warn before tearing down terminals that are still running a
    // foreground process (dev server, editor, agent, …) — and, when the user has
    // enabled "Warn before quit", confirm a plain quit too. Mirrors the
    // per-terminal close confirmation. Deferred async, so we prevent the quit and
    // re-trigger it once the user confirms.
    //
    // Note: updates install on a NORMAL quit (electron-updater autoInstallOnAppQuit),
    // so there's no special update case here — the user is quitting deliberately and
    // the normal terminal-confirmation applies. will-quit handles the install hook.
    if (!quitConfirmed) {
      const prompt = decideQuitPrompt({
        warnBeforeQuit: getSetting('warnBeforeQuit'),
        running: getRunningTerminals(),
      })
      if (prompt) {
        event.preventDefault()
        const focusWin =
          getActiveMainWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
        void dialog
          .showMessageBox(focusWin!, {
            type: 'warning',
            message: prompt.message,
            detail: prompt.detail,
            buttons: ['Quit', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            noLink: true,
          })
          .then((result) => {
            if (result.response === 0) {
              quitConfirmed = true
              app.quit() // re-trigger quit; this gate now passes
            }
            // Cancel: leave the app running.
          })
        return
      }
      // Nothing to confirm — skip the confirmation on the re-triggered pass too.
      quitConfirmed = true
    }

    log.info('Before quit, flushing loggers and requesting session save')
    flushAllLoggers()
    const mainWin = getActiveMainWindow()

    if (!mainWin) {
      // No renderer to save — proceed immediately
      sessionFlushed = true
      return
    }

    // Prevent quit until the renderer confirms session save
    event.preventDefault()

    const proceed = () => {
      sessionFlushed = true
      app.quit()
    }

    // Listen for renderer ACK
    ipcMain.once(SESSION_FLUSH_SAVE_DONE, () => {
      log.info('Session flush save confirmed by renderer')
      proceed()
    })

    // FINAL, AWAITED sync from every dock window FIRST, so the main renderer's
    // session flush (which reads listDockWindows() / main's cached dock state)
    // sees the freshest dock layout + terminal/canvas state instead of stale data
    // from the last sync. Bounded by DOCK_FLUSH_TIMEOUT_MS so an unresponsive
    // dock window can't delay quit. The session-flush safety timeout is armed
    // only once SESSION_FLUSH_SAVE is actually sent, so the dock flush never
    // eats into the main renderer's save budget — the two timeouts are
    // sequential, not shared.
    const dockWindowIds = listDockWindowIds()
    flushDockWindowsBeforeQuit({
      windowIds: dockWindowIds,
      requestSync: (id) => sendToWindow(id, DOCK_WINDOW_FLUSH_SYNC),
      subscribeAck: (handler) => {
        const listener = (e: Electron.IpcMainEvent) => {
          const win = BrowserWindow.fromWebContents(e.sender)
          if (win) handler(win.id)
        }
        ipcMain.on(DOCK_WINDOW_FLUSH_SYNC_DONE, listener)
        return () => ipcMain.removeListener(DOCK_WINDOW_FLUSH_SYNC_DONE, listener)
      },
      timeoutMs: DOCK_FLUSH_TIMEOUT_MS,
    })
      .catch(() => {})
      .finally(() => {
        if (sessionFlushed) return
        if (mainWin.isDestroyed()) {
          // Renderer gone mid-flush — nothing to save from, let quit proceed.
          proceed()
          return
        }
        mainWin.webContents.send(SESSION_FLUSH_SAVE)
        // Safety timeout — don't hang forever if the renderer is unresponsive
        setTimeout(() => {
          if (!sessionFlushed) {
            log.warn('Session flush timed out after %dms, proceeding with quit', FLUSH_TIMEOUT_MS)
            proceed()
          }
        }, FLUSH_TIMEOUT_MS)
      })
  })

  app.on('will-quit', () => {
    // Last-resort synchronous save from cached session data.
    // The renderer flush above should have completed, but this ensures
    // we write something if it didn't.
    log.info('will-quit: sync project state save fallback')
    saveProjectStateSync()
    // Flush any pending debounced settings.json write so a just-changed setting
    // survives the quit (the async writer wouldn't fire before process exit).
    flushSettingsPendingWritesSync()
    // Same for the workspace-state files (recent projects, sidebar, remote
    // workspaces, layouts) — flush their debounced writes before the process exits.
    flushWorkspaceStateSync()
    // Same for the global browser history/bookmarks files.
    flushBrowserStateSync()
    // And the ui-state.json file (minimap placement).
    flushUIStateSync()
    // Drop per-project locks so a co-running instance can take over immediately
    // (a crash skips this; the next instance reclaims the stale lock by pid).
    releaseAllProjectLocks()
    // Kill all PTYs now — AFTER session save so the renderer had access to live
    // PTY data (CWD, scrollback) during the flush triggered in before-quit.
    // Must happen while the JS environment is still alive. If we let them die
    // during Environment::CleanupHandles, node-pty's ThreadSafeFunction exit
    // callback throws into a torn-down context and SIGABRTs the process.
    killAllTerminals()
    // Tear down any remote/WSL runtime connections (kills their daemons /
    // closes SSH). Fire-and-forget — quit must not block on a remote socket.
    void runtimes.disposeAll()
    // An update has been downloaded and is queued to install on quit. DO NOT
    // reallyExit — electron-updater's install-on-quit hook runs on the 'quit'
    // event (which fires AFTER will-quit), so reallyExit (libc exit()) would kill
    // the process first and the update would never apply. Let the natural quit
    // path run; the installer takes over the process shortly.
    if (isUpdatePendingInstall()) {
      log.info('will-quit: update staged, yielding to electron-updater install-on-quit')
      return
    }
    // Force immediate exit to bypass node::FreeEnvironment → CleanupHandles →
    // uv_run, which drains pending ThreadSafeFunction callbacks and can SIGABRT
    // after node-pty teardown. process.reallyExit is Node's binding to libc
    // exit() — it skips the 'exit' event and the cleanup path app.exit/process.exit
    // would run. All important cleanup (session save, logger flush, watcher
    // disposal, process group kills) is already done above.
    ;(process as unknown as { reallyExit(code: number): never }).reallyExit(0)
  })

  // Field-diagnostic trace for the install handoff. When an update is staged we
  // return early from will-quit (above) so electron-updater's install-on-quit hook
  // can run on the 'quit' event. Logging here confirms the quit event actually
  // fired — the missing signal behind past "downloaded but never installed"
  // reports. (No-op when no update is staged.)
  app.on('quit', () => {
    if (isUpdatePendingInstall()) {
      log.info('quit: event fired with update staged — electron-updater install-on-quit should now run')
    }
  })
}
