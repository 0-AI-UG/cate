import { installPersistentSessionTracking, flushPersistentSessions } from '../browser/persistentSessions'
import { randomUUID } from 'node:crypto'
import { app, ipcMain, dialog } from 'electron'
import log from '../logger'
import { createWindow } from '../windows/windowFactory'
import { setMainWindowReady, flushPendingOpenPaths } from './openPath'
import { getActiveMainWindow, sendToWindow, listDockWindowIds, listWindows, windowFromEvent } from '../windowRegistry'
import { flushDockWindowsBeforeQuit } from '../dockWindowFlush'
import { flushAllLoggers, killAllTerminals } from '../ipc/terminal'
import { guardQuit, isQuitCommitted, markQuitCommitted, resetQuitAttempt } from './quitConfirm'
import { saveProjectStateSync } from '../projectWorkspaceStore'
import { flushPendingWritesSync as flushSettingsPendingWritesSync } from '../settingsFile'
import { flushWorkspaceStateSync } from '../workspaceStateStore'
import { flushBrowserStateSync } from '../browserStateStore'
import { flushUIStateSync } from '../uiStateStore'
import { releaseAllProjectLocks } from '../projectLock'
import { runtimes } from '../runtime/runtimeManager'
import { t3HarnessManager } from '../t3Agent/T3HarnessManager'
import { workspaceCateApi } from '../cateApi/workspaceCateApi'
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
//   1. before-quit: confirm with the user (quitConfirm), flush loggers, send
//      SESSION_FLUSH_SAVE to the renderer, defer quit
//   2. renderer saves session (async — needs live PTYs for CWD/scrollback)
//   3. renderer sends SESSION_FLUSH_SAVE_DONE
//   4. main flushes the persistent browser storage/cookie stores
//   5. main process marks the quit committed and re-triggers app.quit()
//   6. before-quit fires again (isQuitCommitted() — falls through)
//   7. will-quit: sync fallback save, kill PTYs, _exit(0)
//
// EVERY quit route lands here with its windows still alive: Cmd+Q and menu-Quit
// arrive directly, and closing the last main window is turned into an app.quit()
// by windowFactory's 'close' gate rather than destroying itself first. That
// ordering is what gives step 1 a window to attach the prompt to and step 2 a
// live renderer to save from.
// ---------------------------------------------------------------------------

const FLUSH_TIMEOUT_MS = 15_000
let sessionFlushPending = false
// Bound the pre-quit dock-window sync so an unresponsive detached window can't
// stall quit. Kept short relative to FLUSH_TIMEOUT_MS — it runs BEFORE the main
// renderer's session flush, so dock sync + session save share the quit budget.
const DOCK_FLUSH_TIMEOUT_MS = 600
const EXIT_DISPOSE_TIMEOUT_MS = 800

type BrowserSessionStore = Pick<Electron.Session, 'cookies' | 'flushStorageData'>

/** Force Chromium's persistent browser state to disk before Cate's hard exit. */
export async function flushPersistentBrowserSession(
  browserSession?: BrowserSessionStore,
): Promise<void> {
  if (!browserSession) return flushPersistentSessions()
  browserSession.flushStorageData()
  await browserSession.cookies.flushStore()
}

// Re-entrancy guard for the hard-exit path: once we've prevented Electron's
// natural teardown and kicked off the bounded dispose, a second will-quit fire
// must not start dispose again (it would double-SIGTERM children and re-arm the
// exit timer). Set once, checked in the handler.
let hardExitStarted = false

/** Prevent natural Electron teardown while stopping harnesses and runtimes.
 * Natural teardown can destroy node-pty callbacks before their children exit. */
export async function runHardExit(
  event: { preventDefault: () => void },
  deps: {
    disposeAll: () => Promise<unknown>
    exit: (code: number) => void
    timeoutMs: number
  },
): Promise<void> {
  event.preventDefault()
  try {
    await Promise.race([
      deps.disposeAll(),
      new Promise((resolve) => setTimeout(resolve, deps.timeoutMs)),
    ])
  } catch {
    /* best-effort — exit regardless */
  }
  deps.exit(0)
}

/**
 * Wire the app-lifecycle event handlers: window-all-closed, activate, and the
 * before-quit / will-quit / quit teardown sequence. Called once from the index
 * bootstrap.
 */
export function registerLifecycleHandlers(): void {
  installPersistentSessionTracking()
  app.on('window-all-closed', () => {
    log.info('All windows closed, quitting')
    app.quit()
  })

  app.on('activate', () => {
    if (listWindows().length === 0) {
      setMainWindowReady(false)
      const win = createWindow({ type: 'main' })
      let readyHandled = false
      const markReady = (reason: string): void => {
        if (readyHandled || win.isDestroyed()) return
        readyHandled = true
        log.info('Activated main window ready via %s', reason)
        setMainWindowReady(true)
        flushPendingOpenPaths()
      }
      win.once('ready-to-show', () => markReady('ready-to-show'))
      win.webContents.once('did-finish-load', () => markReady('did-finish-load'))
    }
  })

  app.on('before-quit', (event) => {
    if (isQuitCommitted()) {
      // Second pass — renderer already saved, let quit proceed to will-quit
      log.info('before-quit: session already flushed, proceeding')
      return
    }

    if (sessionFlushPending) { event.preventDefault(); return }

    // First gate: warn before tearing down terminals that are still running a
    // foreground process (dev server, editor, agent, …) — and, when the user has
    // enabled "Warn before quit", confirm a plain quit too. Mirrors the
    // per-terminal close confirmation. Deferred async, so the quit is prevented
    // and re-triggered once the user confirms.
    //
    // Every quit route reaches this gate with its windows alive (see the flow
    // note at the top), so the prompt always has a window to sheet onto and a
    // Cancel always leaves a fully intact app.
    //
    // Note: updates install on a NORMAL quit (electron-updater autoInstallOnAppQuit),
    // so there's no special update case here — the user is quitting deliberately and
    // the normal terminal-confirmation applies. will-quit handles the install hook.
    const gate = guardQuit(event, getActiveMainWindow() ?? listWindows()[0], () => {
      app.quit() // re-trigger quit; the guard now passes
    })
    if (gate === 'deferred') return

    log.info('Before quit, flushing loggers and requesting session save')
    flushAllLoggers()
    const mainWin = getActiveMainWindow()

    // Prevent quit until the renderer confirms session save
    event.preventDefault()

    sessionFlushPending = true
    const requestId = randomUUID()
    let settled = false
    let flushTimeout: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      sessionFlushPending = false
      if (flushTimeout) clearTimeout(flushTimeout)
      ipcMain.removeListener(SESSION_FLUSH_SAVE_DONE, onFlushDone)
    }
    const abort = (error: string) => {
      if (settled) return
      settled = true
      cleanup()
      resetQuitAttempt()
      log.warn('Session save failed; keeping windows open: %s', error)
      dialog.showErrorBox('Unable to save session', `${error}\nYour windows remain open. Retry quitting after the problem is resolved.`)
    }
    let flushingBrowser = false
    const proceed = () => {
      if (settled || flushingBrowser) return
      flushingBrowser = true
      cleanup()
      sessionFlushPending = true
      void flushPersistentBrowserSession()
        .then(() => {
          settled = true
          sessionFlushPending = false
          markQuitCommitted()
          app.quit()
        }, error => {
          sessionFlushPending = false
          abort(error instanceof Error ? error.message : String(error))
        })
    }

    // Only the main renderer requested above may acknowledge this attempt.
    const onFlushDone = (event: Electron.IpcMainEvent, error?: string, responseId?: string) => {
      if (!mainWin || windowFromEvent(event)?.id !== mainWin.id || responseId !== requestId || settled) return
      if (error) { abort(error); return }
      log.info('Session flush save confirmed by renderer')
      proceed()
    }
    ipcMain.on(SESSION_FLUSH_SAVE_DONE, onFlushDone)

    if (!mainWin) {
      if (listDockWindowIds().length) abort('The main workspace window is unavailable to save detached windows. Reopen it before quitting.')
      else proceed()
      return
    }

    // Agent-session stamps are hook-pushed the moment identity changes, so
    // they are already current at quit — no refresh step. FIRST a FINAL,
    // AWAITED sync from every dock window, so the main renderer's session
    // flush (which reads listDockWindows() / main's cached dock state) sees
    // the freshest dock layout + terminal/canvas state instead of stale data
    // from the last sync. Missing or failed acknowledgements abort this attempt
    // after DOCK_FLUSH_TIMEOUT_MS and keep the remaining owners alive. The session-flush safety timeout is armed
    // only once SESSION_FLUSH_SAVE is actually sent, so the dock flush never
    // eats into the main renderer's save budget — the timeouts are
    // sequential, not shared.
    flushDockWindowsBeforeQuit({
      windowIds: listDockWindowIds(),
      requestSync: (id, dockRequestId) => sendToWindow(id, DOCK_WINDOW_FLUSH_SYNC, dockRequestId),
      subscribeAck: (handler) => {
        const listener = (e: Electron.IpcMainEvent, error?: string, dockRequestId?: string) => {
          const win = windowFromEvent(e)
          if (win) handler(win.id, error, dockRequestId)
        }
        ipcMain.on(DOCK_WINDOW_FLUSH_SYNC_DONE, listener)
        return () => ipcMain.removeListener(DOCK_WINDOW_FLUSH_SYNC_DONE, listener)
      },
      timeoutMs: DOCK_FLUSH_TIMEOUT_MS,
    })
      .then(() => {
        if (isQuitCommitted() || settled) return
        if (mainWin.isDestroyed()) {
          abort('The main workspace window closed before session saving completed.')
          return
        }
        sendToWindow(mainWin.id, SESSION_FLUSH_SAVE, requestId)
        // Missing acknowledgement is not evidence of durability. Keep the live
        // editors available instead of discarding them after a slow/failed save.
        flushTimeout = setTimeout(() => abort('Session saving did not finish in time.'), FLUSH_TIMEOUT_MS)
      }).catch(error => abort(error instanceof Error ? error.message : String(error)))
  })

  app.on('will-quit', (event) => {
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
    releaseAllProjectLocks()
    // Kill all PTYs now — AFTER session save so the renderer had access to live
    // PTY data (CWD, scrollback) during the flush triggered in before-quit.
    // Must happen while the JS environment is still alive. If we let them die
    // during Environment::CleanupHandles, node-pty's ThreadSafeFunction exit
    // callback throws into a torn-down context and SIGABRTs the process.
    killAllTerminals()
    if (isUpdatePendingInstall()) {
      workspaceCateApi.disposeAll()
      void t3HarnessManager.disposeAll()
      void runtimes.disposeAll()
      log.info('will-quit: update staged, yielding to electron-updater install-on-quit')
      return
    }
    if (hardExitStarted) {
      // Re-entrant will-quit fire — keep preventing natural teardown, but the
      // dispose + exit is already in flight; don't start it twice.
      event.preventDefault()
      return
    }
    hardExitStarted = true
    void runHardExit(event, {
      disposeAll: () => {
        // Sync teardown of the first-party CATE_API listeners (tunnel.stopListen
        // is fire-and-forget + reverse.dispose closes the http server), then the
        // bounded async server/runtime dispose.
        workspaceCateApi.disposeAll()
        return Promise.allSettled([t3HarnessManager.disposeAll(), runtimes.disposeAll()])
      },
      // process.reallyExit is Node's binding to libc exit() — it skips the 'exit'
      // event and the cleanup path app.exit/process.exit would run, bypassing
      // node::FreeEnvironment → CleanupHandles → uv_run (which drains pending
      // ThreadSafeFunction callbacks and can SIGABRT after node-pty teardown).
      // All important cleanup (session save, logger flush, watcher disposal,
      // process group kills) is already done synchronously above.
      exit: (code) => (process as unknown as { reallyExit(code: number): never }).reallyExit(code),
      timeoutMs: EXIT_DISPOSE_TIMEOUT_MS,
    })
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
