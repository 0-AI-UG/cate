import log from './logger'
import { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, screen, webContents, session, nativeTheme } from 'electron'
import fs from 'fs'
import path from 'path'
import { SHELL_SHOW_IN_FOLDER, WEBVIEW_SCREENSHOT, BROWSER_SET_PROXY, NATIVE_FILE_DRAG, CAPTURE_PAGE, DIALOG_OPEN_FOLDER, DIALOG_OPEN_IMAGE, DIALOG_SAVE_FILE, DIALOG_CONFIRM_UNSAVED, DIALOG_CONFIRM_CLOSE_TERMINAL, DIALOG_CONFIRM_CLOSE_CANVAS, DIALOG_CONFIRM_IMPORT, DIALOG_CONFIRM_RELOAD_WORKSPACE, DIALOG_TERMINAL_LINK_OPEN, CANVAS_READ_BACKGROUND_IMAGE, APP_OPEN_PATH } from '../shared/ipc-channels'
import {
  WINDOW_SET_TITLE,
  WINDOW_MINIMIZE, WINDOW_TOGGLE_MAXIMIZE, WINDOW_CLOSE, WINDOW_IS_MAXIMIZED, WINDOW_MAXIMIZE_STATE,
  PANEL_TRANSFER, PANEL_RECEIVE, PANEL_TRANSFER_ACK,
  PANEL_WINDOWS_LIST, PANEL_WINDOW_DOCK_BACK, PANEL_WINDOW_SYNC_PTY, PANEL_WINDOW_SYNC_META,
  DRAG_START, DRAG_DETACH, DRAG_END,
  WINDOW_FULLSCREEN_STATE,
  DOCK_WINDOW_INIT, DOCK_WINDOW_SYNC_STATE, DOCK_WINDOWS_LIST,
  CROSS_WINDOW_DRAG_START, CROSS_WINDOW_DRAG_UPDATE, CROSS_WINDOW_DRAG_DROP, CROSS_WINDOW_DRAG_CANCEL, CROSS_WINDOW_DRAG_RESOLVE,
  SESSION_FLUSH_SAVE,
  SESSION_FLUSH_SAVE_DONE,
} from '../shared/ipc-channels'
import { registerHandlers as registerTerminalHandlers, flushAllLoggers, killAllTerminals } from './ipc/terminal'
import { companions, forwardFileGrant, forwardClearFileGrantsForWindow, forwardClearScopedWriteAllowancesForWindow } from './companion/companionManager'
import { registerCompanionHandlers } from './ipc/companion'
import { registerHandlers as registerFilesystemHandlers, stopWatchersForWindow } from './ipc/filesystem'
import { registerHandlers as registerGitHandlers } from './ipc/git'
import { registerHandlers as registerSearchHandlers, stopSearchesForWindow } from './ipc/search'
import { registerHandlers as registerShellHandlers, unregisterTerminalsForWindow, getRunningTerminals } from './ipc/shell'
import { registerHandlers as registerGitMonitorHandlers, stopMonitorsForWindow } from './ipc/git-monitor'
import { registerHandlers as registerStoreHandlers, loadSettingsSyncFromDisk, readBootSnapshot, writeBootSnapshot, getSettingSync, setSettingsFromMain } from './store'
import { flushPendingWritesSync as flushSettingsPendingWritesSync } from './settingsFile'
import { flushWorkspaceStateSync } from './workspaceStateStore'
import { registerUIStateHandlers, flushUIStateSync } from './uiStateStore'
import { importCanvasBackgroundImage } from './canvasBackgroundStore'
import { registerProjectStateHandlers, saveProjectStateSync } from './projectWorkspaceStore'
import { registerHandlers as registerMenuHandlers } from './ipc/menu'
import { registerHandlers as registerNotificationHandlers } from './ipc/notifications'
import { registerAgentHandlers } from '../agent/main/ipcAgent'
import { registerAuthHandlers } from '../agent/main/ipcAuth'
import { authManager } from '../agent/main/authManager'
import { AgentManager } from '../agent/main/agentManager'

// Shared singletons for pi agent + auth.
const agentManager = new AgentManager(authManager)
import { writeDragTempFile, cleanupDragTempFile, createDragGhostImage } from './ipc/drag'
import { registerWindow, getWindowType, sendToWindow, broadcastToAll, broadcastToAllExcept, setPanelWindowMeta, setPanelWindowTerminalPtyId, listPanelWindows, getWindow, setDockWindowState, listDockWindows, focusWindow, windowFromEvent } from './windowRegistry'
import { registerWorkspaceHandlers } from './workspaceManager'
import { addAllowedRoot, clearFileGrantsForWindow, clearScopedWriteAllowancesForWindow, grantFileAccess, validatePath } from './ipc/pathValidation'
import { isLocalLocator } from './companion/locator'
import { listPersistentGrants, recordPersistentGrant } from './grantedPathStore'
import { buildApplicationMenu, rebuildApplicationMenu, setNewMainWindowFn } from './menu'
import { initShellEnv, getShellEnv } from './shellEnv'
import { currentExclusionSet } from './ipc/filesystem'
import { initAutoUpdater, isUpdatePendingInstall } from './auto-updater'
import { initSentry, captureMainException, captureMainMessage, flushSentry } from './sentry'
import { initAnalytics, trackAppStart, checkAndReportUpdate, hasRunBefore, devSimulateUpdateFrom } from './analytics'
import { TELEMETRY_SET_CONSENT } from '../shared/ipc-channels'
import { beginTerminalTransfer, acknowledgeTerminalTransfer, handleCrossWindowDropTerminalTransfer } from './ipc/terminal'
import type { CateWindowParams, DockWindowInitPayload, PanelState, PanelTransferSnapshot, WindowDockState } from '../shared/types'
import { disableRendererSandbox, disableTrustScoping } from './featureFlags'
import { getSharedPanelDef } from '../shared/panels'
import { startPerfMonitor, getLatestSnapshot } from './perf/perfMonitor'
import { PERF_GET } from '../shared/ipc-channels'
import { installWebContentsSecurity } from './webSecurity'
import { configureBrowserProxy, installProxyAuthHandler } from './browserProxy'
import { installThemeSkill } from './installThemeSkill'
import { releaseAllProjectLocks } from './projectLock'
import {
  startCrossWindowDrag,
  updateCrossWindowCursor,
  cancelCrossWindowDrag,
  claimCrossWindowDrop,
  resolveCrossWindowDrag,
  decideDetach,
  clampGhostSize,
  ghostPosition,
  isCursorInsideAnyAppWindow,
  CROSS_WINDOW_POLL_MS,
  CROSS_WINDOW_CLAIM_WAIT_MS,
  type CrossWindowDragState,
  type GhostHostWindow,
} from './dragLogic'

/** True when any existing Cate BrowserWindow is in macOS native fullscreen.
 *  Used to reject window-creation IPCs so the app can never "escape" into a
 *  separate Space while the user is in fullscreen mode. */
function anyWindowFullscreen(): boolean {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    try { if (w.isFullScreen()) return true } catch { /* noop */ }
  }
  return false
}

// NOTE: runSmokeAssertions only ever runs when CATE_SMOKE_TEST=1. The 1200 ms
// wait below is part of the smoke-only branch in mainWin.once('ready-to-show')
// and never executes on normal launches. Do not re-introduce it on the hot path.
async function runSmokeAssertions(win: BrowserWindow): Promise<void> {
  const result = await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          hasElectronAPI: typeof window.electronAPI === 'object',
          hasFullscreenCheck: typeof window.electronAPI?.isMainWindowFullscreen === 'function',
        })
      }, 1200)
    })
  `, true) as { hasElectronAPI?: boolean; hasFullscreenCheck?: boolean }

  if (!result?.hasElectronAPI || !result?.hasFullscreenCheck) {
    throw new Error('Smoke test failed: preload bridge did not initialize correctly')
  }
}

// Under Playwright (CATE_E2E=1) a normal show() opens the window on the user's
// active screen and steals focus — and on macOS a *shown* window can't be kept
// off-screen (off-screen coordinates get clamped back onto a display). So under
// e2e we never show the window at all: it's never mapped to a display, and
// Playwright drives the renderer over CDP. A hidden window throttles its rAF
// loop, so the renderer is instead made deterministic without a visible window
// elsewhere (e2eHarness zeroes CSS animations; canvas nodes are created already
// idle; node removal is finalized immediately) so the drag specs stay reliable.
const IS_E2E = process.env.CATE_E2E === '1'

/** Show a window — but under e2e keep it hidden (never mapped to a display) so it
 *  never appears on screen or steals focus. Playwright drives it over CDP. */
function revealWindow(win: BrowserWindow, opts: { focus?: boolean } = {}): void {
  try {
    if (IS_E2E) return // never map to a display — Playwright drives it over CDP
    win.show()
    if (opts.focus) win.focus()
  } catch {
    /* window may already be destroyed */
  }
}

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

function installRendererCrashRecovery(win: BrowserWindow, windowType: string, windowId: number): void {
  let reloads: number[] = []

  win.webContents.on('render-process-gone', (_event, details) => {
    // 'clean-exit' is a normal teardown (the window is closing) — not a crash.
    if (details.reason === 'clean-exit') return
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

function createWindow(params?: CateWindowParams): BrowserWindow {
  const iconPath = path.join(__dirname, '../../build/icon-1024.png')
  const windowType = params?.type ?? 'main'
  const isPanel = windowType === 'panel'
  const isDock = windowType === 'dock'

  // Boot snapshot — used only for the main window. Lets us restore the user's
  // last window bounds + theme-matched background color synchronously, so the
  // first frame matches the final UI and there's no white flash.
  const bootSnap = windowType === 'main' ? readBootSnapshot() : null
  const snapGeom = bootSnap?.geometry
  const snapBg = bootSnap?.backgroundColor
  // The exact background color used for both the native window backdrop and the
  // renderer's first-paint loading splash, so the splash matches the themed
  // window before the renderer's JS theme injection runs.
  const bgColor = snapBg ?? '#1f1e1c'

  // Apply the active theme's native appearance before the window exists so
  // native chrome (menus, scrollbars, the window backdrop) paints with the
  // right dark/light material on the first frame. themeSource is app-wide, so
  // we only need it once from the main window's snapshot; the renderer keeps it
  // in sync after.
  if (windowType === 'main' && bootSnap?.appearance) {
    try { nativeTheme.themeSource = bootSnap.appearance } catch { /* noop */ }
  }

  const win = new BrowserWindow({
    width: snapGeom?.width ?? (isDock ? 700 : isPanel ? 700 : 1200),
    height: snapGeom?.height ?? (isDock ? 500 : isPanel ? 500 : 800),
    x: snapGeom?.x,
    y: snapGeom?.y,
    show: false,
    minWidth: isDock ? 400 : isPanel ? undefined : 800,
    minHeight: isDock ? 300 : isPanel ? undefined : 600,
    title: isDock ? 'Cate' : isPanel ? 'Cate Panel' : 'Cate',
    // macOS: hide the native title bar and draw a themed strip in its place (the
    // macOS native bar can't be tinted to a theme color — only dark/light — so we
    // always use `hiddenInset`/`hidden` and render TitlebarStrip).
    // Windows/Linux: go fully frameless and draw our own window controls in the
    // renderer (WindowControls), so the chrome matches the theme. `titleBarStyle`
    // is irrelevant once `frame:false`.
    titleBarStyle: process.platform === 'darwin' ? (isPanel ? 'hidden' : 'hiddenInset') : 'default',
    // Align traffic lights with our 28px themed TitlebarStrip on macOS. Apple's
    // standard NSWindow title bar is ~28pt with lights at y≈7; matching that
    // here makes the themed bar visually identical to a native title bar.
    trafficLightPosition: process.platform !== 'darwin'
      ? undefined
      : isDock
        ? { x: 12, y: 11 }
        : windowType === 'main'
          ? { x: 10, y: 6 }
          : undefined,
    // macOS main windows keep a (hidden-inset) native frame; everything else —
    // all panel/dock windows, and every window on Windows/Linux — is frameless.
    frame: process.platform === 'darwin' ? !(isPanel || isDock) : false,
    backgroundColor: bgColor,
    icon: nativeImage.createFromPath(iconPath),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: !disableRendererSandbox(),
      webSecurity: true,
      webviewTag: true,
      // Under e2e the window is never shown (revealWindow is a no-op).
      // paintWhenInitiallyHidden makes the hidden renderer paint + fire
      // ready-to-show anyway; backgroundThrottling:false keeps its rAF/timers
      // running. (CSS animations are also disabled in e2eHarness.) Harmless
      // no-ops outside e2e.
      ...(IS_E2E ? { backgroundThrottling: false, paintWhenInitiallyHidden: true } : {}),
    },
  })

  // Show on ready-to-show so the first frame is fully painted before the
  // window appears — eliminates the white flash from initial mount.
  win.once('ready-to-show', () => {
    revealWindow(win)
  })

  // Persist main-window geometry to the boot snapshot so the next cold launch
  // restores bounds synchronously (no white flash). The store debounces, so
  // emitting on every move/resize is cheap.
  if (windowType === 'main') {
    const captureGeometry = (): void => {
      try {
        if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
        const [x, y] = win.getPosition()
        const [width, height] = win.getSize()
        writeBootSnapshot({ geometry: { x, y, width, height } })
      } catch { /* noop */ }
    }
    win.on('move', captureGeometry)
    win.on('resize', captureGeometry)
  }

  // Track this window in the registry with its type
  registerWindow(win, windowType, params?.workspaceId)

  // Capture ID before window is destroyed (win.id throws after 'closed')
  const windowId = win.id
  log.info('Creating window type=%s id=%d', windowType, windowId)

  // Recover from renderer crashes / hangs (OOM, GPU fault, native crash) that
  // React's ErrorBoundary can't see.
  installRendererCrashRecovery(win, windowType, windowId)

  // Re-arm grants for every persisted Save-As path so editors restored in
  // this window (any window type — main, panel, dock) can read+save their
  // out-of-workspace files. We check the file still exists; missing entries
  // are pruned so the store doesn't grow unbounded with stale paths. The
  // returned promise gates loadURL below so the renderer's session-restore
  // pass cannot mount an out-of-workspace editor before its grant lands.
  const grantsReady = (async () => {
    try {
      const paths = await listPersistentGrants()
      for (const filePath of paths) {
        // Note: we do NOT prune missing files here. If the user deletes or
        // moves the file off-disk between sessions, the grant must survive
        // so that the editor restored with `filePath = …/missing.txt` can
        // still receive a Cmd+S that recreates the file at the previously
        // approved location. The grant only writes/reads to/from that
        // exact path; it does not widen access elsewhere.
        try {
          await grantFileAccess(windowId, filePath)
          // Mirror the grant into the owning companion's authoritative map so a
          // restored out-of-root editor can read/save against the daemon.
          forwardFileGrant(filePath, windowId)
        } catch (err) {
          log.warn('[grants] Failed to grant %s to window %d: %s', filePath, windowId, err)
        }
      }
    } catch (err) {
      log.warn('[grants] Failed to apply persisted grants:', err)
    }
  })()

  // When the main window is closed, also close any detached panel/dock
  // windows so the app actually quits (otherwise they keep the process
  // alive and `window-all-closed` never fires).
  if (windowType === 'main') {
    win.on('close', () => {
      for (const other of BrowserWindow.getAllWindows()) {
        if (other.id === windowId || other.isDestroyed()) continue
        const t = getWindowType(other.id)
        if (t === 'panel' || t === 'dock') {
          // Use close() rather than destroy() — destroy() tears down a
          // BrowserWindow without letting its <webview> children unload,
          // which crashes the GPU/renderer process on quit and triggers
          // macOS's "closed unexpectedly" dialog.
          try { other.close() } catch { /* noop */ }
        }
      }
    })
  }

  // Clean up window-owned resources on close
  win.on('closed', () => {
    log.debug('Window closed id=%d', windowId)
    stopWatchersForWindow(windowId)
    unregisterTerminalsForWindow(windowId)
    stopMonitorsForWindow(windowId)
    stopSearchesForWindow(windowId)
    clearScopedWriteAllowancesForWindow(windowId)
    clearFileGrantsForWindow(windowId)
    // Forward the clears to every registered companion (the daemon keeps its own
    // grant maps; a window close has no locator, so fan out to all hosts).
    forwardClearScopedWriteAllowancesForWindow(windowId)
    forwardClearFileGrantsForWindow(windowId)
    // Rebuild menu to update panel/dock window list
    if (isPanel || isDock) rebuildApplicationMenu()
    // Trigger immediate session save from main window when a child window closes
    if (windowType !== 'main') {
      const allWindows = BrowserWindow.getAllWindows()
      const mainWin = allWindows.find((w) => !w.isDestroyed() && getWindowType(w.id) === 'main')
      if (mainWin) {
        mainWin.webContents.send(SESSION_FLUSH_SAVE)
      }
    }
  })

  // Rebuild menu when panel/dock windows are created
  if (isPanel || isDock) {
    win.webContents.once('did-finish-load', () => {
      rebuildApplicationMenu()
    })
  }

  // Broadcast fullscreen state changes so the renderer can react
  // (e.g., hide detach affordances). The authoritative check is a sync IPC
  // handler registered once below, but these broadcasts cover the cache
  // path used by any listener that wants push updates.
  const broadcastFullscreenState = (): void => {
    const isFullscreen = anyWindowFullscreen()
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue
      try { w.webContents.send(WINDOW_FULLSCREEN_STATE, isFullscreen) } catch { /* noop */ }
    }
  }
  win.on('enter-full-screen', broadcastFullscreenState)
  win.on('leave-full-screen', broadcastFullscreenState)
  // Fire at the *start* of the transition too so the renderer can hide the
  // header drag-region before macOS begins its slide animation, instead of
  // waiting for the post-animation enter/leave events.
  const broadcastEntering = (): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue
      try { w.webContents.send(WINDOW_FULLSCREEN_STATE, true) } catch { /* noop */ }
    }
  }
  const broadcastLeaving = (): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue
      try { w.webContents.send(WINDOW_FULLSCREEN_STATE, false) } catch { /* noop */ }
    }
  }
  // macOS-only events; cast to sidestep missing type overloads.
  ;(win as unknown as { on: (e: string, fn: () => void) => void }).on('will-enter-full-screen', broadcastEntering)
  ;(win as unknown as { on: (e: string, fn: () => void) => void }).on('will-leave-full-screen', broadcastLeaving)
  win.webContents.once('did-finish-load', broadcastFullscreenState)

  // Push this window's own maximize state to its renderer so the custom window
  // controls (WindowControls, Windows/Linux) can swap the maximize/restore glyph.
  // Per-window (not broadcast): each window's maximize state is independent.
  const sendMaximizeState = (): void => {
    if (win.isDestroyed()) return
    try { win.webContents.send(WINDOW_MAXIMIZE_STATE, win.isMaximized()) } catch { /* noop */ }
  }
  win.on('maximize', sendMaximizeState)
  win.on('unmaximize', sendMaximizeState)
  win.webContents.once('did-finish-load', sendMaximizeState)

  // Build query string from params
  const queryParts: string[] = []
  queryParts.push(`type=${encodeURIComponent(windowType)}`)
  // Pass the themed boot background so the renderer can paint its loading splash
  // to match the window backdrop on the first frame (main window only).
  if (windowType === 'main') queryParts.push(`bg=${encodeURIComponent(bgColor)}`)
  if (params?.panelType) queryParts.push(`panelType=${encodeURIComponent(params.panelType)}`)
  if (params?.panelId) queryParts.push(`panelId=${encodeURIComponent(params.panelId)}`)
  if (params?.workspaceId) queryParts.push(`workspaceId=${encodeURIComponent(params.workspaceId)}`)
  const query = queryParts.length > 0 ? `?${queryParts.join('&')}` : ''

  // Defer loadURL until persisted grants are applied. Without this, the
  // renderer can begin session restore and mount an editor pointing at an
  // out-of-workspace path before grantFileAccess has populated the window's
  // grant set, causing fsReadFile to be rejected and the editor to mount
  // empty for a file we should have been able to read.
  void grantsReady.finally(() => {
    if (win.isDestroyed()) return
    if (process.env.ELECTRON_RENDERER_URL) {
      win.loadURL(`${process.env.ELECTRON_RENDERER_URL}${query}`)
    } else {
      win.loadFile(path.join(__dirname, '../renderer/index.html'), {
        search: query ? query.slice(1) : undefined,
      })
    }
  })

  return win
}

// =============================================================================
// Drag ghost window — a tiny borderless always-on-top window that follows the
// cursor during cross-window drags so the user has visual feedback outside any
// app window.
// =============================================================================

let dragGhostWin: BrowserWindow | null = null

function createDragGhostWindow(
  panelType: string,
  panelTitle: string,
  ghostWidth: number,
  ghostHeight: number,
): void {
  if (dragGhostWin && !dragGhostWin.isDestroyed()) {
    dragGhostWin.destroy()
  }

  // Clamp ghost size to sane bounds so we don't spawn a massive native window.
  const { width: w, height: h } = clampGhostSize(ghostWidth, ghostHeight)

  dragGhostWin = new BrowserWindow({
    width: w,
    height: h,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    focusable: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  // Tag this window so the cursor-poll loop can exclude it when deciding
  // whether the cursor is over a Cate window.
  ;(dragGhostWin as unknown as { __isDragGhost: boolean }).__isDragGhost = true

  // Ignore mouse events so the ghost doesn't interfere with drop targets
  dragGhostWin.setIgnoreMouseEvents(true)

  const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
  const icon = getSharedPanelDef(panelType).ghostSvg
  const safeTitle = escapeHtml(panelTitle.slice(0, 40))
  const html = `data:text/html;charset=utf-8,<!DOCTYPE html>
<html><head><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:transparent;overflow:hidden;font:11px -apple-system,sans-serif}
.ghost{width:100vw;height:100vh;display:flex;flex-direction:column;
 border:1.5px solid rgba(74,158,255,0.7);background:rgba(74,158,255,0.08);
 border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.5);overflow:hidden}
.tbar{height:24px;flex:0 0 24px;display:flex;align-items:center;gap:6px;
 padding:0 10px;background:rgba(42,42,58,0.95);
 border-bottom:1px solid rgba(255,255,255,0.08);
 color:rgba(255,255,255,0.85);font-weight:500;white-space:nowrap;overflow:hidden}
.tbar svg{flex-shrink:0}
.tbar .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.body{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:16px}
.body .big{opacity:0.9}
.body .lbl{color:rgba(74,158,255,0.85);font-size:11px;font-weight:500}
</style></head><body><div class="ghost"><div class="tbar">${icon}<span class="t">${safeTitle}</span></div><div class="body"><div class="big"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgba(74,158,255,0.85)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/></svg></div><div class="lbl">Drop to place here</div></div></div></body></html>`

  dragGhostWin.loadURL(html)
  dragGhostWin.webContents.once('did-finish-load', () => {
    if (dragGhostWin && !dragGhostWin.isDestroyed()) {
      dragGhostWin.showInactive()
    }
  })
}

function moveDragGhostWindow(
  screenX: number,
  screenY: number,
  grabOffsetX?: number,
  grabOffsetY?: number,
): void {
  if (dragGhostWin && !dragGhostWin.isDestroyed()) {
    const grab = grabOffsetX != null || grabOffsetY != null
      ? { x: grabOffsetX ?? 12, y: grabOffsetY ?? 12 }
      : null
    const pos = ghostPosition({ x: screenX, y: screenY }, grab)
    dragGhostWin.setPosition(pos.x, pos.y, false)
  }
}

function destroyDragGhostWindow(): void {
  if (dragGhostWin && !dragGhostWin.isDestroyed()) {
    dragGhostWin.destroy()
  }
  dragGhostWin = null
}

// =============================================================================
// Register all IPC handlers ONCE (not per-window)
// =============================================================================

/**
 * Critical-path IPC handlers — registered synchronously before the first
 * BrowserWindow is created. These are everything the renderer might call
 * during settings load, session restore, and the first paint.
 *
 * Terminal + shell handlers are in the critical set because terminal:create
 * can fire as soon as the session restore reaches a terminal node, which can
 * happen before `ready-to-show`. Pushing them to the deferred set caused
 * "no handler registered" errors in practice.
 */
function registerCriticalHandlers(): void {
  registerStoreHandlers()
  registerUIStateHandlers()
  registerProjectStateHandlers()
  registerWorkspaceHandlers()
  registerFilesystemHandlers()
  registerTerminalHandlers()
  registerShellHandlers()
  registerMenuHandlers()
  registerWindowAndDialogHandlers()
  // Resource profiler — no-op unless CATE_PERF=1.
  startPerfMonitor()
  ipcMain.handle(PERF_GET, () => getLatestSnapshot())
}

/**
 * Background IPC handlers — registered after the first paint inside
 * mainWin.once('ready-to-show'). Nothing on the critical render path
 * should depend on these.
 */
function registerDeferredHandlers(): void {
  registerGitHandlers()
  registerSearchHandlers()
  registerGitMonitorHandlers()
  registerNotificationHandlers()
  registerAuthHandlers(authManager)
  registerAgentHandlers(authManager, agentManager)
  registerCompanionHandlers()
}

/**
 * Window, dialog, panel-transfer, drag, and ad-hoc IPC handlers. Split out so
 * registerCriticalHandlers can include them without duplicating the bodies.
 */
function registerWindowAndDialogHandlers(): void {
  // Shell: Reveal in Finder
  ipcMain.handle(SHELL_SHOW_IN_FOLDER, async (_event, filePath: string) => {
    // A remote (cate-companion://) path has no representation on this machine —
    // there is nothing local to reveal. Return a structured result instead of
    // throwing so the renderer can quietly ignore/disable the action.
    if (!isLocalLocator(filePath)) {
      return { ok: false, reason: 'remote' }
    }
    try {
      shell.showItemInFolder(validatePath(filePath))
      return { ok: true }
    } catch (error) {
      log.error('[SHELL_SHOW_IN_FOLDER]', error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  // Dialog handlers
  ipcMain.handle(DIALOG_OPEN_FOLDER, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose Project Folder',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Pick an image to use as the canvas wallpaper. The picked file is COPIED into
  // managed app data (see ./canvasBackgroundStore) and the managed path is
  // returned for storage in settings — so the wallpaper survives the source
  // file moving/being deleted and stays self-contained. The renderer reads the
  // bytes via CANVAS_READ_BACKGROUND_IMAGE; no path grant is needed because that
  // reader runs in main (full fs access) rather than through the sandboxed fs IPC.
  ipcMain.handle(DIALOG_OPEN_IMAGE, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: 'Choose Canvas Background Image',
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return importCanvasBackgroundImage(result.filePaths[0])
  })

  // Read a canvas-wallpaper image as a data URL. Used both right after the user
  // picks one and on every launch to restore the saved path. Guarded by
  // extension + size so a hand-edited settings.json can't turn this into an
  // arbitrary file-to-data-URL exfiltration primitive.
  ipcMain.handle(CANVAS_READ_BACKGROUND_IMAGE, async (_event, filePath: unknown) => {
    if (typeof filePath !== 'string' || filePath === '') return null
    const MIME_BY_EXT: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.avif': 'image/avif',
    }
    const ext = path.extname(filePath).toLowerCase()
    const mime = MIME_BY_EXT[ext]
    if (!mime) return null
    try {
      const stat = await fs.promises.stat(filePath)
      const MAX_BYTES = 40 * 1024 * 1024 // 40 MB ceiling — keeps a data URL sane.
      if (!stat.isFile() || stat.size > MAX_BYTES) return null
      const buf = await fs.promises.readFile(filePath)
      return `data:${mime};base64,${buf.toString('base64')}`
    } catch (err) {
      log.warn('[CANVAS_READ_BACKGROUND_IMAGE] Failed to read %s: %O', filePath, err)
      return null
    }
  })

  // Native Save-As dialog for untitled editor buffers.
  ipcMain.handle(DIALOG_SAVE_FILE, async (event, payload: { defaultName?: string; defaultPath?: string }) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const result = await dialog.showSaveDialog(win!, {
      title: 'Save File',
      defaultPath: payload?.defaultPath || payload?.defaultName || 'Untitled.txt',
    })
    if (result.canceled || !result.filePath) return null
    // The picked location is almost always outside the workspace allowed
    // roots (Desktop, Documents, …). Grant the calling window persistent
    // read+write access to the exact file so the initial fsWriteFile AND
    // every subsequent reload / Cmd+S on this editor succeed for the
    // lifetime of the window. The grant is dropped on window close.
    // Return the canonical safe path (realpath-of-parent + basename) so the
    // renderer stores the same string the grant set keys on — otherwise a
    // symlinked parent would yield a stored alias that later fails the
    // lexical validatePath check before realpath has a chance to run.
    if (win) {
      try {
        const safePath = await grantFileAccess(win.id, result.filePath)
        // Mirror the grant into the owning companion (the LOCAL daemon owns this
        // host-absolute path) so the initial write + later reloads validate there.
        forwardFileGrant(safePath, win.id)
        // Persist the approval so future windows (and future app launches)
        // can read+write this file via createWindow's grantsReady pass.
        // Critically there is NO renderer-facing IPC to add paths here —
        // only paths the user just confirmed in a native dialog land in
        // the store.
        try {
          await recordPersistentGrant(safePath)
        } catch (err) {
          log.warn('[DIALOG_SAVE_FILE] Failed to persist grant:', err)
        }
        // Grant the path to every currently-open window too. Without this,
        // a panel transferred to a window that existed BEFORE the Save-As
        // would lose access (createWindow's grantsReady only runs at the
        // owning window's creation — older sibling windows never see the
        // newly approved path otherwise).
        for (const other of BrowserWindow.getAllWindows()) {
          if (other.id === win.id || other.isDestroyed()) continue
          try {
            await grantFileAccess(other.id, safePath)
            forwardFileGrant(safePath, other.id)
          } catch (err) {
            log.warn('[DIALOG_SAVE_FILE] Failed to grant to window %d: %s', other.id, err)
          }
        }
        return safePath
      } catch (err) {
        log.warn('[DIALOG_SAVE_FILE] Failed to grant file access:', err)
      }
    }
    return result.filePath
  })

  // Native unsaved-changes confirmation. Returns 'save' | 'discard' | 'cancel'.
  ipcMain.handle(
    DIALOG_CONFIRM_UNSAVED,
    async (event, payload: { fileName?: string; multiple?: boolean; filePath?: string }) => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const name = payload?.fileName ?? 'this file'
      const message = payload?.multiple
        ? `Do you want to save the changes you made to ${payload?.fileName ?? 'these files'}?`
        : `Do you want to save the changes you made to ${name}?`
      // For a single dirty file, show the on-disk location so the user knows
      // exactly which file the "Save" button is going to overwrite. Untitled
      // buffers (no filePath) fall back to a hint that a Save-As picker will
      // appear after confirming.
      const baseDetail = "Your changes will be lost if you don't save them."
      const detail = payload?.multiple
        ? baseDetail
        : payload?.filePath
          ? `${payload.filePath}\n\n${baseDetail}`
          : `This file has not been saved yet. Save will prompt for a location.\n\n${baseDetail}`
      const result = await dialog.showMessageBox(win!, {
        type: 'warning',
        message,
        detail,
        buttons: ['Save', "Don't Save", 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      })
      return result.response === 0 ? 'save' : result.response === 1 ? 'discard' : 'cancel'
    },
  )

  // Confirm closing a terminal that's running a foreground process (dev server,
  // editor, agent, …). Returns 'close' | 'cancel'.
  ipcMain.handle(
    DIALOG_CONFIRM_CLOSE_TERMINAL,
    async (event, payload: { count?: number; processName?: string | null }) => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const count = payload?.count ?? 1
      const name = payload?.processName?.trim()
      const message =
        count > 1
          ? `Close ${count} terminals that are still running?`
          : name
            ? `“${name}” is still running. Close this terminal?`
            : 'This terminal is still running. Close it?'
      const detail =
        count > 1
          ? 'The processes running in these terminals will be terminated.'
          : 'The process running in this terminal will be terminated.'
      const result = await dialog.showMessageBox(win!, {
        type: 'warning',
        message,
        detail,
        buttons: ['Close', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      })
      return result.response === 0 ? 'close' : 'cancel'
    },
  )

  // Confirm close of a canvas panel. When the workspace has other canvases and
  // the closing canvas contains panels, the user is offered three choices:
  // move the panels to another canvas, delete them, or cancel. When it's the
  // last canvas (or empty) a simple close/cancel prompt is shown.
  ipcMain.handle(DIALOG_CONFIRM_CLOSE_CANVAS, async (event, payload: { panelCount: number; isLast: boolean }) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const { panelCount, isLast } = payload ?? { panelCount: 0, isLast: true }

    // Simple close prompt: last canvas, or an empty canvas on a multi-canvas workspace.
    if (isLast || panelCount === 0) {
      const result = await dialog.showMessageBox(win!, {
        type: 'warning',
        message: 'Close this canvas?',
        detail: isLast
          ? 'This is the only canvas in the workspace.'
          : 'This canvas has no open panels.',
        buttons: ['Close', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      return result.response === 0 ? 'close' : 'cancel'
    }

    // Multi-canvas workspace with contained panels: offer move / delete / cancel.
    const result = await dialog.showMessageBox(win!, {
      type: 'warning',
      message: 'Close this canvas?',
      detail: `This canvas contains ${panelCount} open ${panelCount === 1 ? 'panel' : 'panels'}. What would you like to do with them?`,
      buttons: ['Move to Another Canvas', 'Delete All Panels', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    })
    return result.response === 0 ? 'move' : result.response === 1 ? 'delete' : 'cancel'
  })

  // Ask whether to copy or move external files/folders dropped onto the file
  // explorer into a workspace directory.
  ipcMain.handle(DIALOG_CONFIRM_IMPORT, async (event, payload: { count: number; destName: string }) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const count = payload?.count ?? 0
    const destName = payload?.destName ?? 'this folder'
    const result = await dialog.showMessageBox(win!, {
      type: 'question',
      message: `Add ${count} ${count === 1 ? 'item' : 'items'} to "${destName}"?`,
      detail: 'Copy keeps the originals where they are. Move removes them from their current location.',
      buttons: ['Copy', 'Move', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    })
    return result.response === 0 ? 'copy' : result.response === 1 ? 'move' : 'cancel'
  })

  // Confirm reloading the canvas after the workspace.json file changed on disk
  // (edited externally while Cate was running).
  ipcMain.handle(DIALOG_CONFIRM_RELOAD_WORKSPACE, async (event, payload: { name?: string }) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const name = payload?.name?.trim()
    const result = await dialog.showMessageBox(win!, {
      type: 'question',
      message: 'Reload workspace from disk?',
      detail: `The workspace file${name ? ` for "${name}"` : ''} changed on disk. Reload to apply it? This rebuilds the canvas and restarts terminals; the current in-app layout will be discarded.`,
      buttons: ['Reload', 'Keep Current'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    return result.response === 0 ? 'reload' : 'cancel'
  })

  // Ask where to open a Cmd/Ctrl+clicked terminal link the first time (while the
  // terminalLinkOpenTarget setting is 'ask'). The chosen target is remembered by
  // the renderer and can be changed later in Settings → Browser.
  ipcMain.handle(DIALOG_TERMINAL_LINK_OPEN, async (event, payload: { url: string }) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const url = payload?.url ?? ''
    const result = await dialog.showMessageBox(win!, {
      type: 'question',
      message: 'Open link',
      detail: `${url}\n\nYou can change this later in Settings → Browser.`,
      buttons: ['On Canvas', 'In System Browser', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    })
    return result.response === 0 ? 'canvas' : result.response === 1 ? 'external' : 'cancel'
  })

  // Capture page screenshot for panel previews
  ipcMain.handle(CAPTURE_PAGE, async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win.isDestroyed()) return null
      const image = await win.webContents.capturePage()
      return image.toDataURL()
    } catch (error) {
      log.error('[CAPTURE_PAGE]', error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  // Capture a webview's visible content, save to Desktop, return dataUrl + path
  ipcMain.handle(WEBVIEW_SCREENSHOT, async (event, webContentsId: number) => {
    try {
      // Validate the webContentsId belongs to a webview guest of the calling window
      const callerWin = BrowserWindow.fromWebContents(event.sender)
      const wc = webContents.fromId(webContentsId)
      if (!wc || wc.isDestroyed()) return null
      // Ensure the target webContents belongs to the caller's window
      const targetWin = BrowserWindow.fromWebContents(wc)
      if (!callerWin || !targetWin || targetWin.id !== callerWin.id) {
        // For webview guests, the host window should match the caller
        const hostWc = wc.hostWebContents
        if (!hostWc || hostWc.id !== event.sender.id) {
          log.warn(`[webview:screenshot] Denied: webContentsId ${webContentsId} does not belong to calling window`)
          return null
        }
      }
      const image = await wc.capturePage()
      if (image.isEmpty()) return null

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const fileName = `screenshot-${timestamp}.png`
      const filePath = path.join(app.getPath('desktop'), fileName)
      await fs.promises.writeFile(filePath, image.toPNG())

      return { filePath, dataUrl: image.toDataURL() }
    } catch (error) {
      log.error(`[${WEBVIEW_SCREENSHOT}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  // Configure a browser panel's per-partition proxy (issue #241). Awaited by the
  // renderer before it mounts the <webview> so the first request is proxied.
  ipcMain.handle(BROWSER_SET_PROXY, async (_event, partition: string, proxyUrl?: string) => {
    try {
      await configureBrowserProxy(partition, proxyUrl)
    } catch (error) {
      log.error(`[${BROWSER_SET_PROXY}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  // Native file drag from renderer (for screenshot thumbnails etc.)
  ipcMain.handle(NATIVE_FILE_DRAG, async (event, filePath: string) => {
    // A remote path has no local file to export into a native OS drag — no-op
    // rather than mis-resolving the locator against the local filesystem.
    if (!isLocalLocator(filePath)) {
      return { ok: false, reason: 'remote' }
    }
    try {
      const validPath = validatePath(filePath)
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return
      // Create a small drag icon from the file
      const iconSize = 64
      const iconImage = nativeImage.createFromPath(validPath)
      const icon = iconImage.isEmpty() ? nativeImage.createEmpty() : iconImage.resize({ width: iconSize })
      event.sender.startDrag({ file: validPath, icon })
    } catch (error) {
      log.error('[NATIVE_FILE_DRAG]', error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  // Renderer-driven title sync — used so each native macOS tab shows the
  // active workspace name instead of the generic app title.
  ipcMain.handle(WINDOW_SET_TITLE, async (event, title: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    if (typeof title === 'string' && title.length > 0) {
      win.setTitle(title)
    }
  })

  // Custom window controls (frameless Windows/Linux chrome). Per-window: resolve
  // the calling window from the IPC sender so a panel/dock window controls itself.
  ipcMain.handle(WINDOW_MINIMIZE, (event) => {
    windowFromEvent(event)?.minimize()
  })
  ipcMain.handle(WINDOW_TOGGLE_MAXIMIZE, (event) => {
    const win = windowFromEvent(event)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle(WINDOW_CLOSE, (event) => {
    windowFromEvent(event)?.close()
  })
  ipcMain.on(WINDOW_IS_MAXIMIZED, (event) => {
    event.returnValue = windowFromEvent(event)?.isMaximized() ?? false
  })

  // Panel transfer protocol
  ipcMain.handle(PANEL_TRANSFER, async (event, snapshot: PanelTransferSnapshot, targetWindowId?: number, workspaceId?: string) => {
    // Begin terminal buffering if this is a terminal transfer
    if (snapshot.terminalPtyId) {
      beginTerminalTransfer(snapshot.terminalPtyId, targetWindowId ?? -1)
    }

    if (targetWindowId) {
      // Transfer to existing window
      sendToWindow(targetWindowId, PANEL_RECEIVE, snapshot)
      // Track panel metadata for the target window (keep its existing workspace
      // id unless the caller supplied one)
      setPanelWindowMeta(targetWindowId, snapshot.panel, workspaceId)
    } else {
      // Refuse creating a new panel window while any Cate window is in
      // macOS native fullscreen — the new window would land in a separate
      // Space and appear as an empty black page. Caller should fall back to
      // keeping the panel in the source window.
      if (anyWindowFullscreen()) return null
      // Create a new panel window and send the transfer there. Pass the source
      // workspaceId so the window is registered to it at creation — otherwise it
      // is persisted to no workspace and lost on the next restart.
      const newWin = createWindow({
        type: 'panel',
        panelType: snapshot.panel.type,
        panelId: snapshot.panel.id,
        workspaceId,
      })

      // Track panel metadata
      setPanelWindowMeta(newWin.id, snapshot.panel, workspaceId)

      // Position at saved geometry if available
      if (snapshot.geometry) {
        newWin.setBounds({
          x: Math.round(snapshot.geometry.origin.x),
          y: Math.round(snapshot.geometry.origin.y),
          width: Math.round(snapshot.geometry.size.width),
          height: Math.round(snapshot.geometry.size.height),
        })
      }

      // Update target for terminal buffering
      if (snapshot.terminalPtyId) {
        beginTerminalTransfer(snapshot.terminalPtyId, newWin.id)
      }

      // Wait for the window to be ready, then send the snapshot
      newWin.webContents.once('did-finish-load', () => {
        sendToWindow(newWin.id, PANEL_RECEIVE, snapshot)
      })

      return newWin.id
    }
  })

  ipcMain.handle(PANEL_TRANSFER_ACK, async (_event, ptyId?: string) => {
    if (ptyId) {
      acknowledgeTerminalTransfer(ptyId)
    }
  })

  // List all active panel windows with their metadata and bounds
  ipcMain.handle(PANEL_WINDOWS_LIST, async () => {
    return listPanelWindows()
  })

  // Renderer reports a panel window's terminal ptyId so we can persist it for replay on next launch
  ipcMain.handle(PANEL_WINDOW_SYNC_PTY, async (event, ptyId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setPanelWindowTerminalPtyId(win.id, ptyId)
  })

  // Renderer pushes an updated PanelState — used after Save-As inside a
  // detached panel window so the windowRegistry meta (the source for
  // session persistence + the panel-window list) reflects the new
  // filePath/title/clean state instead of the at-transfer-time snapshot.
  ipcMain.handle(PANEL_WINDOW_SYNC_META, async (event, payload: { panel: PanelState; workspaceId?: string }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || !payload?.panel) return
    setPanelWindowMeta(win.id, payload.panel, payload.workspaceId)
  })

  // Double-click panel window title bar → close the panel window and signal main window to dock
  ipcMain.handle(PANEL_WINDOW_DOCK_BACK, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    // Broadcast to main window(s) that this panel should be re-docked
    broadcastToAll(PANEL_WINDOW_DOCK_BACK, win.id)
    // Close the panel window
    win.close()
  })

  // Cross-window drag-and-drop
  ipcMain.handle(DRAG_START, async (event, snapshot: PanelTransferSnapshot) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return

    const tempFile = writeDragTempFile(snapshot)
    const icon = createDragGhostImage()

    win.webContents.startDrag({
      file: tempFile,
      icon,
    })
  })

  ipcMain.handle(DRAG_DETACH, async (_event, snapshot: PanelTransferSnapshot, workspaceId?: string) => {
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)

    // Decide whether to detach and where to place the new window. `decideDetach`
    // refuses when any Cate window is in macOS native fullscreen (the new window
    // would land in a separate Space and appear black). Caller treats a null
    // return as "detach rejected — put the panel back where it came from".
    const decision = decideDetach({
      anyWindowFullscreen: anyWindowFullscreen(),
      cursor,
      grabOffset: { x: 12, y: 12 },
      size: {
        width: snapshot.geometry?.size?.width ?? 700,
        height: snapshot.geometry?.size?.height ?? 500,
      },
      displayBounds: display.workArea,
    })
    if (decision.kind === 'refuse') return null

    // Begin terminal buffering if applicable
    if (snapshot.terminalPtyId) {
      beginTerminalTransfer(snapshot.terminalPtyId, -1)
    }

    const newWin = createWindow({
      type: 'dock',
      panelType: snapshot.panel.type,
      panelId: snapshot.panel.id,
      workspaceId,
    })

    // Update terminal transfer target now that we have the window ID
    if (snapshot.terminalPtyId) {
      beginTerminalTransfer(snapshot.terminalPtyId, newWin.id)
    }

    newWin.setBounds({
      x: decision.position.x,
      y: decision.position.y,
      width: decision.size.width,
      height: decision.size.height,
    })

    // Build initial dock state: single center zone with one tab stack
    const initPayload: DockWindowInitPayload = {
      panels: { [snapshot.panel.id]: snapshot.panel },
      dockState: buildSinglePanelDockState(snapshot.panel.id),
      workspaceId: workspaceId ?? '',
    }

    // Send the init payload + transfer snapshot once the window is ready
    newWin.webContents.once('did-finish-load', () => {
      sendToWindow(newWin.id, DOCK_WINDOW_INIT, initPayload)
      sendToWindow(newWin.id, PANEL_RECEIVE, snapshot)
      // Force show + focus — on macOS in fullscreen, the new window may not
      // auto-show because the OS thinks it belongs to a different Space.
      // (revealWindow skips the focus and stays inactive under e2e.)
      revealWindow(newWin, { focus: true })
    })

    cleanupDragTempFile()
    broadcastToAll(DRAG_END)

    return newWin.id
  })

  // Synchronous fullscreen getter — renderers hit this on every drag
  // mousemove to decide whether to enter dock-drag / cross-window mode.
  // sendSync is fine at ~60 Hz and guarantees no stale state.
  ipcMain.on(WINDOW_FULLSCREEN_STATE, (event) => {
    event.returnValue = anyWindowFullscreen()
  })

  ipcMain.on(DRAG_END, () => {
    cleanupDragTempFile()
    broadcastToAll(DRAG_END)
  })

  // Dock window state sync (renderer -> main for session persistence)
  ipcMain.handle(DOCK_WINDOW_SYNC_STATE, async (event, state: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setDockWindowState(win.id, state as { dockState: any; panels: Record<string, PanelState>; workspaceId: string })
  })

  // List all dock windows with state and bounds
  ipcMain.handle(DOCK_WINDOWS_LIST, async () => {
    return listDockWindows()
  })

  // Cross-window drag coordination — `crossWindowDragState` is the pure state
  // (managed via dragLogic functions); `pollTimer` is the Electron-effect that
  // shadows it. They're cleared together.
  let crossWindowDragState: CrossWindowDragState | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null

  // Used by CROSS_WINDOW_DRAG_RESOLVE to detect if a target window claimed the
  // drop before the claim-wait timer fires.
  let crossWindowDropClaimedResolve: (() => void) | null = null

  const stopPollTimer = (): void => {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  ipcMain.handle(CROSS_WINDOW_DRAG_START, async (event, snapshot: PanelTransferSnapshot, _screenPos: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return

    // Refuse any cross-window drag while any Cate window is in macOS
    // native fullscreen — the drag ghost would land in a different Space
    // (black window). Lock the drag to the source window entirely.
    if (anyWindowFullscreen()) return

    const cursor = screen.getCursorScreenPoint()
    crossWindowDragState = startCrossWindowDrag({
      sourceWindowId: win.id,
      snapshot,
      cursor,
    })

    // Create the native drag ghost window — size to match the source panel
    // (canvas-space size; clamped inside createDragGhostWindow).
    createDragGhostWindow(
      snapshot.panel.type,
      snapshot.panel.title,
      snapshot.geometry?.size?.width ?? 320,
      snapshot.geometry?.size?.height ?? 200,
    )

    // Poll cursor position: move ghost, broadcast to all windows EXCEPT source
    pollTimer = setInterval(() => {
      if (!crossWindowDragState) return
      const pos = screen.getCursorScreenPoint()
      crossWindowDragState = updateCrossWindowCursor(crossWindowDragState, pos)
      moveDragGhostWindow(pos.x, pos.y)

      // Hide the native ghost when the cursor is over any Cate window — the
      // in-renderer DragOverlay handles the visual there. Show it again when
      // the cursor leaves all Cate windows (e.g. on the desktop between
      // windows) so the user still has a drag affordance.
      if (dragGhostWin && !dragGhostWin.isDestroyed()) {
        const overCateWindow = isCursorInsideAnyAppWindow(
          pos,
          BrowserWindow.getAllWindows() as unknown as GhostHostWindow[],
        )
        if (overCateWindow) {
          if (dragGhostWin.isVisible()) dragGhostWin.hide()
        } else {
          if (!dragGhostWin.isVisible()) dragGhostWin.showInactive()
        }
      }

      broadcastToAllExcept(crossWindowDragState.sourceWindowId, CROSS_WINDOW_DRAG_UPDATE, pos, crossWindowDragState.snapshot)
    }, CROSS_WINDOW_POLL_MS)
  })

  ipcMain.handle(CROSS_WINDOW_DRAG_DROP, async (event, _panelId: string) => {
    if (crossWindowDragState) {
      stopPollTimer()
      // Mark the state as claimed (pure transition). The resolver below reads
      // `claimed` to decide whether to tell the source to remove its node.
      crossWindowDragState = claimCrossWindowDrop(crossWindowDragState, Date.now())
      // Arm terminal-ownership transfer to the target (receiver) window — the
      // receiver's reconnectTerminal will panelTransferAck after wiring its
      // listeners, and ack is a no-op without a prior begin.
      const targetWin = BrowserWindow.fromWebContents(event.sender)
      if (targetWin && crossWindowDragState!.snapshot.terminalPtyId) {
        handleCrossWindowDropTerminalTransfer(
          crossWindowDragState!.snapshot.terminalPtyId,
          targetWin.id,
        )
      }
      // Notify source window to remove the panel
      sendToWindow(crossWindowDragState!.sourceWindowId, DRAG_END)
    }
    destroyDragGhostWindow()

    // Fire the pending resolver (if any). It will read `claimed=true` from
    // the state above and resolve `{ claimed: true }` to the source window.
    // The resolver is also responsible for nullifying `crossWindowDragState`.
    if (crossWindowDropClaimedResolve) {
      crossWindowDropClaimedResolve()
    } else {
      // No resolve in flight — clear state directly so a future resolve
      // (which would arrive after the source mouseup) returns unclaimed.
      crossWindowDragState = cancelCrossWindowDrag(crossWindowDragState)
    }
  })

  ipcMain.handle(CROSS_WINDOW_DRAG_CANCEL, async () => {
    if (!crossWindowDragState) return
    stopPollTimer()
    crossWindowDragState = cancelCrossWindowDrag(crossWindowDragState)
    destroyDragGhostWindow()
    broadcastToAll(DRAG_END)
  })

  // Resolve cross-window drag on mouseup from source window.
  // Broadcasts DRAG_END, waits briefly for a target window to claim via
  // CROSS_WINDOW_DRAG_DROP, then returns whether the drop was claimed. If not,
  // source falls back to DRAG_DETACH.
  ipcMain.handle(CROSS_WINDOW_DRAG_RESOLVE, async () => {
    if (!crossWindowDragState) return { claimed: false }

    const sourceId = crossWindowDragState.sourceWindowId

    // Stop polling but keep the state alive so DROP can still claim it within
    // the short wait window below.
    stopPollTimer()
    const stateAtResolve = { ...crossWindowDragState, resolvedAt: Date.now() }
    crossWindowDragState = stateAtResolve

    destroyDragGhostWindow()

    // Broadcast DRAG_END to non-source windows so target windows check their drop targets
    broadcastToAllExcept(sourceId, DRAG_END)

    // Wait briefly for a target window to call CROSS_WINDOW_DRAG_DROP.
    return new Promise<{ claimed: boolean }>((resolve) => {
      const finish = (now: number): void => {
        crossWindowDropClaimedResolve = null
        void now
        const decision = resolveCrossWindowDrag(crossWindowDragState)
        crossWindowDragState = cancelCrossWindowDrag(crossWindowDragState)
        resolve({ claimed: decision.claimed })
      }

      const timeout = setTimeout(() => finish(Date.now()), CROSS_WINDOW_CLAIM_WAIT_MS)

      crossWindowDropClaimedResolve = () => {
        clearTimeout(timeout)
        finish(Date.now())
      }
    })
  })
}

// =============================================================================
// Helpers
// =============================================================================

/** Build a WindowDockState with a single panel in the center zone */
function buildSinglePanelDockState(panelId: string): WindowDockState {
  const stackId = crypto.randomUUID()
  return {
    left: { position: 'left', visible: false, size: 260, layout: null },
    right: { position: 'right', visible: false, size: 260, layout: null },
    bottom: { position: 'bottom', visible: false, size: 240, layout: null },
    center: {
      position: 'center',
      visible: true,
      size: 0,
      layout: {
        type: 'tabs',
        id: stackId,
        panelIds: [panelId],
        activeIndex: 0,
      },
    },
  }
}

// =============================================================================
// App lifecycle
// =============================================================================

// Set app name before menu and window creation
app.setName('Cate')

// Windows: the toast notification system keys off the AppUserModelID, and it
// must match the install shortcut's ID (electron-builder uses `appId`) for the
// notification 'click' event to fire reliably. No-op on macOS/Linux.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.cate.app')
}

// In dev mode, use a separate userData directory so dev and production don't collide
if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('userData'), 'Dev'))
}

// First-start simulation (`npm run dev:firststart`). Point userData at a
// dedicated dir that's wiped on every launch, so the app boots exactly like a
// brand-new install: telemetry-consent prompt + onboarding tour, empty session,
// no recent projects or saved window geometry. Dev-only; never in a packaged app.
if (!app.isPackaged && process.env.CATE_FRESH_USERDATA === '1') {
  const fs = require('fs') as typeof import('fs')
  const dir = path.join(app.getPath('userData'), 'FirstStart')
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ }
  fs.mkdirSync(dir, { recursive: true })
  app.setPath('userData', dir)
  log.info('[firststart] fresh userData (wiped on each launch): %s', dir)
}

// Dev-only: simulate launching right after an update at a given level
// (major / minor / patch). Uses its own wiped userData dir, then seeds the
// analytics state so `checkAndReportUpdate` sees a version bump from a synthetic
// previous version. The grandfather block below then treats it as an existing
// (already-onboarded, already-consented) user, so only the post-update feedback
// dialog can appear — major/minor show it, patch shows nothing. See dev:update:*.
if (!app.isPackaged && (process.env.CATE_SIMULATE_UPDATE === 'major' || process.env.CATE_SIMULATE_UPDATE === 'minor' || process.env.CATE_SIMULATE_UPDATE === 'patch')) {
  const level = process.env.CATE_SIMULATE_UPDATE
  const fs = require('fs') as typeof import('fs')
  const dir = path.join(app.getPath('userData'), `SimUpdate-${level}`)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ }
  fs.mkdirSync(dir, { recursive: true })
  app.setPath('userData', dir)
  const from = devSimulateUpdateFrom(level)
  log.info('[sim-update] %s: simulating update %s → %s (userData: %s)', level, from, app.getVersion(), dir)
}

// In E2E mode, use a fresh tmpdir per launch so Playwright runs are isolated
// from each other and from local dev state. The harness sets CATE_E2E=1.
if (process.env.CATE_E2E === '1') {
  // The e2e window is never shown, so Chromium throttles it. Per-window
  // backgroundThrottling:false isn't enough on Windows: its native occlusion
  // detection marks a never-mapped window as occluded and freezes the
  // compositor — and with it the rAF loop that applies node-drag transforms —
  // so every drag spec times out on the Windows runner while no-op specs pass.
  // These switches (no-ops on macOS/Linux, where the symptom doesn't occur)
  // disable that occlusion freeze and renderer/timer backgrounding. Must run
  // before app-ready, which this module-level block does.
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-background-timer-throttling')

  const fs = require('fs') as typeof import('fs')
  const os = require('os') as typeof import('os')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-e2e-'))
  app.setPath('userData', tmp)
  // Keep the e2e app out of the macOS dock / app-switcher so launching it never
  // foregrounds the shared Electron bundle (and a running `npm run dev`).
  app.dock?.hide()
}

// ---------------------------------------------------------------------------
// Dock / "Open With..." folder opens (macOS `open-file` event)
//
// Fires when the user drops a folder onto the dock icon or opens one with
// Cate via Finder. We resolve the folder to a directory and forward it to
// the main renderer, which creates a new workspace rooted at that path.
//
// The event can fire *before* the window is ready, so we queue paths and
// flush once the main window signals ready-to-show.
// ---------------------------------------------------------------------------

const pendingOpenPaths: string[] = []
let mainWindowReady = false

function findMainWindow(): BrowserWindow | null {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    if (getWindowType(w.id) === 'main') return w
  }
  return null
}

function deliverOpenPath(p: string): void {
  const win = findMainWindow()
  if (!win || !mainWindowReady) {
    pendingOpenPaths.push(p)
    return
  }
  try {
    // Skip in e2e so opening a path never foregrounds the shared Electron bundle.
    if (!IS_E2E) focusWindow(win)
  } catch { /* noop */ }
  win.webContents.send(APP_OPEN_PATH, p)
}

function flushPendingOpenPaths(): void {
  if (!pendingOpenPaths.length) return
  const win = findMainWindow()
  if (!win) return
  for (const p of pendingOpenPaths.splice(0)) {
    win.webContents.send(APP_OPEN_PATH, p)
  }
}

app.on('open-file', (event, filePath) => {
  event.preventDefault()
  log.info('open-file event: %s', filePath)
  deliverOpenPath(filePath)
})

// Build application menu
buildApplicationMenu()

log.info('Cate v%s starting (electron %s, node %s, platform %s)', app.getVersion(), process.versions.electron, process.versions.node, process.platform)

// Load persisted settings synchronously so window-creation code paths can read
// them before the async electron-store finishes initializing.
loadSettingsSyncFromDisk()

// Scope the WHOLE first-run experience (telemetry-consent screen + onboarding
// tour) to genuine first installs. Anyone who has launched Cate before (incl.
// users upgrading from a pre-onboarding / pre-consent build) is marked as past
// it, so an update shows ONLY the post-update feedback dialog — never the tour
// and never the consent screen. Telemetry stays OFF for these grandfathered
// users (they never opted in); they can enable it from Settings. Runs long
// before the renderer queries settings, so there's no show/hide race.
if (hasRunBefore()) {
  if (!getSettingSync('onboardingCompleted')) {
    void setSettingsFromMain({ onboardingCompleted: true })
  }
  if (!getSettingSync('telemetryConsentDecided')) {
    void setSettingsFromMain({
      telemetryConsentDecided: true,
      crashReportingEnabled: false,
      usageAnalyticsEnabled: false,
    })
  }
}

// Under Playwright the profile is a fresh tmpdir, which would otherwise trigger
// the first-run consent + onboarding takeover and cover the canvas the specs
// drive. Mark both as already handled so e2e starts on a clean canvas. Runs
// before the renderer queries settings, so the dialogs never flash.
if (IS_E2E) {
  void setSettingsFromMain({ telemetryConsentDecided: true, onboardingCompleted: true })
}

// Initialize Sentry as early as possible — after settings load (so the opt-out
// is honored) but before any IPC handlers or windows. No-op if DSN unset or
// the user has disabled crash reporting.
initSentry()
initAnalytics()

// Fire the first-run/version-change analytics + app_start. Held back entirely
// until the user has made a telemetry choice, so we never persist install state
// (or send anything) pre-consent. The event sends inside are additionally gated
// by the usage-analytics toggle; the version-detection + welcome prompt run once
// consent is decided either way.
function fireStartupTelemetry(mainWin: BrowserWindow): void {
  if (!getSettingSync('telemetryConsentDecided')) {
    log.info('[telemetry] startup events deferred — awaiting first-run consent')
    return
  }
  checkAndReportUpdate(mainWin).catch((err) => log.warn('Update detection failed:', err))
  trackAppStart()
}

// First-run telemetry consent from the renderer. Persists the choice, applies it
// live (Sentry on/off without restart), and releases the previously-deferred
// startup analytics.
ipcMain.handle(TELEMETRY_SET_CONSENT, async (_e, choice: { crashReporting?: boolean; usageAnalytics?: boolean }) => {
  const crashReporting = choice?.crashReporting === true
  const usageAnalytics = choice?.usageAnalytics === true
  await setSettingsFromMain({
    telemetryConsentDecided: true,
    crashReportingEnabled: crashReporting,
    usageAnalyticsEnabled: usageAnalytics,
  })
  // initSentry now sees consent=true; it inits only if crash reporting was accepted.
  initSentry()
  const mainWin = BrowserWindow.getAllWindows().find(
    (w) => !w.isDestroyed() && getWindowType(w.id) === 'main',
  )
  if (mainWin) fireStartupTelemetry(mainWin)
})

// Provide the menu module a way to spawn additional main windows without
// importing this file (which would create a circular dependency).
setNewMainWindowFn(() => createWindow({ type: 'main' }))

// ---------------------------------------------------------------------------
// Crash / signal teardown. Local terminals run in the companion daemon
// subprocess: when this main process dies its stdin closes, and the daemon's
// `process.stdin.on('close')` handler (src/companion/index.ts) group-kills its
// ptys and exits — so dev servers/watchers don't survive as zombies. No
// in-process PTY cleanup is needed here anymore.
// ---------------------------------------------------------------------------

// Global error handlers — Sentry (when configured) captures the error before
// process exit.
process.on('uncaughtException', (err) => {
  log.error('uncaughtException: %O', err)
  captureMainException(err)
  flushSentry().finally(() => process.exit(1))
})
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection: %O', reason)
  captureMainException(reason)
})

process.on('SIGTERM', () => {
  log.info('Received SIGTERM, exiting')
  process.exit(0)
})

process.on('SIGINT', () => {
  log.info('Received SIGINT, exiting')
  process.exit(0)
})

app.whenReady().then(async () => {
  // Phase 0 perf marker — log a high-resolution timestamp at app.whenReady
  // so cold-launch traces can be reconstructed from main + renderer logs.
  log.info('[perf] app.whenReady t=%dms', Math.round(performance.now()))
  log.info('App ready, resolving shell environment...')

  // Resolve the user's real shell environment before registering handlers.
  // This ensures MCP servers, `which` lookups, etc. see the full PATH.
  await initShellEnv()
  log.info('Shell environment resolved')

  // Bring the local workspace online: provision + launch the host-target companion
  // tarball as a local daemon, the same path remote hosts use. Done after the shell
  // env so the daemon inherits the full PATH for git/terminals. This registers a
  // DeferredCompanion SYNCHRONOUSLY (resolve(LOCAL) works immediately) and connects
  // the daemon in the background, so first-run tarball provisioning never blocks
  // the window paint — early IPC ops queue behind the deferred's `ready`.
  companions.ensureLocalCompanion({
    root: app.getPath('home'),
    exclusions: [...currentExclusionSet()],
    env: getShellEnv(),
    idleSuspend: getSettingSync('autoSuspendIdleTerminals'),
  })

  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({
      applicationName: app.getName(),
      applicationVersion: app.getVersion(),
      version: app.getVersion(),
      copyright: `© ${new Date().getFullYear()} Cate`,
    })
  }

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const origin = details.url
    if (origin.startsWith('file://') || (process.env.ELECTRON_RENDERER_URL && origin.startsWith(process.env.ELECTRON_RENDERER_URL))) {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            `default-src 'self'; script-src 'self'${process.env.ELECTRON_RENDERER_URL ? " 'unsafe-inline' 'unsafe-eval'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: file:; connect-src 'self' https: ws: wss: sentry-ipc:; font-src 'self' data:; base-uri 'self'`,
          ],
        },
      })
    } else {
      callback({})
    }
  })

  installWebContentsSecurity()
  installProxyAuthHandler()
  registerCriticalHandlers()
  log.info('Critical IPC handlers registered')

  // Install the cate-theme authoring skill into ~/.claude/skills (copy-if-missing).
  void installThemeSkill()

  const mainWin = createWindow({ type: 'main' })
  log.info('Main window created (id=%d)', mainWin.id)

  if (disableTrustScoping()) {
    addAllowedRoot(app.getPath('home'))
    log.warn('[security] Trust scoping disabled via dev-only flag; home directory restored to allowed roots')
  }

  // Check for a crash report from the previous session — shows an opt-in
  // dialog if one exists. Deferred until after the window is ready so the
  // dialog has a parent window and doesn't block startup.
  mainWin.once('ready-to-show', () => {
    mainWindowReady = true
    flushPendingOpenPaths()
    // Register deferred IPC handlers and start the auto-updater now that the
    // first paint has landed. Anything not on the cold-launch critical path
    // belongs here.
    registerDeferredHandlers()
    log.info('Deferred IPC handlers registered')
    initAutoUpdater()
    // Detect a version change since last launch and emit an app_updated event
    // before app_start, so the upgrade path lands in analytics in order. Held
    // back on first run until the user accepts/declines telemetry consent.
    fireStartupTelemetry(mainWin)
    if (process.env.CATE_SMOKE_TEST === '1') {
      runSmokeAssertions(mainWin)
        .then(() => app.exit(0))
        .catch((err) => {
          log.error('[smoke] %O', err)
          app.exit(1)
        })
    }
  })
})

app.on('window-all-closed', () => {
  log.info('All windows closed, quitting')
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindowReady = false
    const win = createWindow({ type: 'main' })
    win.once('ready-to-show', () => {
      mainWindowReady = true
      flushPendingOpenPaths()
    })
  }
})

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

app.on('before-quit', (event) => {
  if (sessionFlushed) {
    // Second pass — renderer already saved, let quit proceed to will-quit
    log.info('before-quit: session already flushed, proceeding')
    return
  }

  // First gate: warn before tearing down terminals that are still running a
  // foreground process (dev server, editor, agent, …). Mirrors the per-terminal
  // close confirmation. Deferred async, so we prevent the quit and re-trigger it
  // once the user confirms.
  //
  // Note: updates install on a NORMAL quit (electron-updater autoInstallOnAppQuit),
  // so there's no special update case here — the user is quitting deliberately and
  // the normal terminal-confirmation applies. will-quit handles the install hook.
  if (!quitConfirmed) {
    const running = getRunningTerminals()
    if (running.length > 0) {
      event.preventDefault()
      const allWindows = BrowserWindow.getAllWindows()
      const focusWin =
        allWindows.find((w) => !w.isDestroyed() && getWindowType(w.id) === 'main') ??
        allWindows.find((w) => !w.isDestroyed())
      const count = running.length
      const name = count === 1 ? running[0].processName?.trim() : undefined
      const message =
        count > 1
          ? `${count} terminals are still running. Quit anyway?`
          : name
            ? `“${name}” is still running. Quit anyway?`
            : 'A terminal is still running. Quit anyway?'
      void dialog
        .showMessageBox(focusWin!, {
          type: 'warning',
          message,
          detail:
            count > 1
              ? 'The processes running in these terminals will be terminated.'
              : 'The process running in this terminal will be terminated.',
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
    // Nothing running — skip the confirmation on the re-triggered pass too.
    quitConfirmed = true
  }

  log.info('Before quit, flushing loggers and requesting session save')
  flushAllLoggers()
  const allWindows = BrowserWindow.getAllWindows()
  const mainWin = allWindows.find((w) => !w.isDestroyed() && getWindowType(w.id) === 'main')

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

  // Safety timeout — don't hang forever if the renderer is unresponsive
  setTimeout(() => {
    if (!sessionFlushed) {
      log.warn('Session flush timed out after %dms, proceeding with quit', FLUSH_TIMEOUT_MS)
      proceed()
    }
  }, FLUSH_TIMEOUT_MS)

  mainWin.webContents.send(SESSION_FLUSH_SAVE)
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
  // Tear down any remote/WSL companion connections (kills their daemons /
  // closes SSH). Fire-and-forget — quit must not block on a remote socket.
  void companions.disposeAll()
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
