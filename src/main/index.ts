import log from './logger'
import { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, screen, webContents, session } from 'electron'
import fs from 'fs'
import path from 'path'
import { SHELL_SHOW_IN_FOLDER, WEBVIEW_SCREENSHOT, NATIVE_FILE_DRAG, CAPTURE_PAGE, DIALOG_OPEN_FOLDER, DIALOG_SAVE_FILE, DIALOG_CONFIRM_UNSAVED, DIALOG_CONFIRM_CLOSE_CANVAS, DIALOG_CONFIRM_DELETE_REGION, DIALOG_CONFIRM_IMPORT, DIALOG_CONFIRM_RELOAD_WORKSPACE, APP_OPEN_PATH } from '../shared/ipc-channels'
import {
  WINDOW_SET_TITLE,
  PANEL_TRANSFER, PANEL_RECEIVE, PANEL_TRANSFER_ACK,
  PANEL_WINDOWS_LIST, PANEL_WINDOW_DOCK_BACK, PANEL_WINDOW_SYNC_PTY, PANEL_WINDOW_SYNC_META,
  DRAG_START, DRAG_DETACH, DRAG_END,
  WINDOW_FULLSCREEN_STATE,
  DOCK_WINDOW_INIT, DOCK_WINDOW_SYNC_STATE, DOCK_WINDOWS_LIST,
  CROSS_WINDOW_DRAG_START, CROSS_WINDOW_DRAG_UPDATE, CROSS_WINDOW_DRAG_DROP, CROSS_WINDOW_DRAG_CANCEL, CROSS_WINDOW_DRAG_RESOLVE,
  SESSION_FLUSH_SAVE,
  SESSION_FLUSH_SAVE_DONE,
} from '../shared/ipc-channels'
import { registerHandlers as registerTerminalHandlers, flushAllLoggers, killAllTerminals, terminalPids } from './ipc/terminal'
import { registerHandlers as registerFilesystemHandlers, stopWatchersForWindow } from './ipc/filesystem'
import { registerHandlers as registerGitHandlers } from './ipc/git'
import { registerHandlers as registerShellHandlers, unregisterTerminalsForWindow } from './ipc/shell'
import { registerHandlers as registerGitMonitorHandlers, stopMonitorsForWindow } from './ipc/git-monitor'
import { registerHandlers as registerStoreHandlers, loadSettingsSyncFromDisk, getSettingSync, readBootSnapshot, writeBootSnapshot } from './store'
import { registerProjectStateHandlers, saveProjectStateSync, runLegacyMigrationIfNeeded } from './projectWorkspaceStore'
import { registerHandlers as registerMenuHandlers } from './ipc/menu'
import { registerHandlers as registerNotificationHandlers } from './ipc/notifications'
import { registerAgentHandlers } from '../agent/main/ipcAgent'
import { registerAuthHandlers } from '../agent/main/ipcAuth'
import { authManager } from '../agent/main/authManager'
import { AgentManager } from '../agent/main/agentManager'

// Shared singletons for pi agent + auth.
const agentManager = new AgentManager(authManager)
import { writeDragTempFile, cleanupDragTempFile, createDragGhostImage } from './ipc/drag'
import { registerWindow, getWindowType, sendToWindow, broadcastToAll, broadcastToAllExcept, setPanelWindowMeta, setPanelWindowTerminalPtyId, listPanelWindows, getWindow, setDockWindowState, listDockWindows } from './windowRegistry'
import { registerWorkspaceHandlers } from './workspaceManager'
import { addAllowedRoot, clearFileGrantsForWindow, clearScopedWriteAllowancesForWindow, grantFileAccess, validatePath } from './ipc/pathValidation'
import { listPersistentGrants, recordPersistentGrant } from './grantedPathStore'
import { buildApplicationMenu, rebuildApplicationMenu, setNewMainWindowFn } from './menu'
import { initShellEnv } from './shellEnv'
import { initAutoUpdater, isInstallingUpdate } from './auto-updater'
import { initSentry, captureMainException, flushSentry } from './sentry'
import { initAnalytics, trackAppStart, checkAndReportUpdate } from './analytics'
import { beginTerminalTransfer, acknowledgeTerminalTransfer, handleCrossWindowDropTerminalTransfer } from './ipc/terminal'
import type { CateWindowParams, DockWindowInitPayload, PanelState, PanelTransferSnapshot, WindowDockState } from '../shared/types'
import { disableRendererSandbox, disableTrustScoping } from './featureFlags'
import { getSharedPanelDef } from '../shared/panels'
import { installWebContentsSecurity } from './webSecurity'
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

  // Snapshot native-tabs state at window creation. The renderer reads this via
  // the URL query so that the React TitlebarStrip matches the actual
  // titleBarStyle — toggling the setting at runtime only takes effect on the
  // next launch.
  const nativeTabsActive = process.platform === 'darwin' && windowType === 'main' && getSettingSync('nativeTabs')

  const win = new BrowserWindow({
    width: snapGeom?.width ?? (isDock ? 700 : isPanel ? 700 : 1200),
    height: snapGeom?.height ?? (isDock ? 500 : isPanel ? 500 : 800),
    x: snapGeom?.x,
    y: snapGeom?.y,
    show: false,
    minWidth: isDock ? 400 : isPanel ? undefined : 800,
    minHeight: isDock ? 300 : isPanel ? undefined : 600,
    title: isDock ? 'Cate' : isPanel ? 'Cate Panel' : 'Cate',
    // macOS native window tabs require a standard title bar — `hiddenInset`
    // suppresses the tab bar entirely. When native tabs are enabled for main
    // windows we fall back to the default title bar so the tab strip (app
    // name tab + "+" button) can render.
    titleBarStyle: isPanel ? 'hidden' : nativeTabsActive ? 'default' : 'hiddenInset',
    // Align traffic lights with our 28px themed TitlebarStrip on macOS. Apple's
    // standard NSWindow title bar is ~28pt with lights at y≈7; matching that
    // here makes the themed bar visually identical to a native title bar.
    trafficLightPosition: isDock
      ? { x: 12, y: 11 }
      : (process.platform === 'darwin' && windowType === 'main' && !nativeTabsActive)
        ? { x: 10, y: 6 }
        : undefined,
    frame: !(isPanel || isDock),
    // macOS native window tabs — only on main windows. Setting tabbingIdentifier
    // makes new windows in this group join as native tabs in the title bar
    // (subject to System Settings → Desktop & Dock → "Prefer tabs"). Panel and
    // dock windows are excluded so they stay free-floating.
    ...(nativeTabsActive ? { tabbingIdentifier: 'cate-main' } : {}),
    backgroundColor: snapBg ?? '#1f1e1c',
    icon: nativeImage.createFromPath(iconPath),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: !disableRendererSandbox(),
      webSecurity: true,
      webviewTag: true,
    },
  })

  // Show on ready-to-show so the first frame is fully painted before the
  // window appears — eliminates the white flash from initial mount.
  win.once('ready-to-show', () => {
    try { win.show() } catch { /* destroyed */ }
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
  registerWindow(win, windowType)

  // Capture ID before window is destroyed (win.id throws after 'closed')
  const windowId = win.id
  log.info('Creating window type=%s id=%d', windowType, windowId)

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
    clearScopedWriteAllowancesForWindow(windowId)
    clearFileGrantsForWindow(windowId)
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

  // Build query string from params
  const queryParts: string[] = []
  queryParts.push(`type=${encodeURIComponent(windowType)}`)
  if (nativeTabsActive) queryParts.push('nativeTabsBoot=1')
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
  registerProjectStateHandlers()
  registerWorkspaceHandlers()
  registerFilesystemHandlers()
  registerTerminalHandlers()
  registerShellHandlers()
  registerMenuHandlers()
  registerWindowAndDialogHandlers()
}

/**
 * Background IPC handlers — registered after the first paint inside
 * mainWin.once('ready-to-show'). Nothing on the critical render path
 * should depend on these.
 */
function registerDeferredHandlers(): void {
  registerGitHandlers()
  registerGitMonitorHandlers()
  registerNotificationHandlers()
  registerAuthHandlers(authManager)
  registerAgentHandlers(authManager, agentManager)
}

/** Union of critical + deferred — kept for any callers that want the full set in one call. */
function registerAllHandlers(): void {
  registerCriticalHandlers()
  registerDeferredHandlers()
}

/**
 * Window, dialog, panel-transfer, drag, and ad-hoc IPC handlers. Split out so
 * registerCriticalHandlers can include them without duplicating the bodies.
 */
function registerWindowAndDialogHandlers(): void {
  // Shell: Reveal in Finder
  ipcMain.handle(SHELL_SHOW_IN_FOLDER, async (_event, filePath: string) => {
    try {
      shell.showItemInFolder(validatePath(filePath))
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

  // Confirm deletion of a region that contains panels. Lets the user choose
  // between also deleting the panels inside or just removing the region frame.
  ipcMain.handle(DIALOG_CONFIRM_DELETE_REGION, async (event, payload: { panelCount: number }) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const panelCount = payload?.panelCount ?? 0
    const result = await dialog.showMessageBox(win!, {
      type: 'warning',
      message: 'Delete this region?',
      detail: `This region contains ${panelCount} ${panelCount === 1 ? 'panel' : 'panels'}. Delete them too, or just remove the region around them?`,
      buttons: ['Delete Region + Contents', 'Delete Region Only', 'Cancel'],
      defaultId: 1,
      cancelId: 2,
      noLink: true,
    })
    return result.response === 0 ? 'with-contents' : result.response === 1 ? 'region-only' : 'cancel'
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
  // (edited externally, e.g. by an agent following the .cate skill).
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

  // Native file drag from renderer (for screenshot thumbnails etc.)
  ipcMain.handle(NATIVE_FILE_DRAG, async (event, filePath: string) => {
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

  // Panel transfer protocol
  ipcMain.handle(PANEL_TRANSFER, async (event, snapshot: PanelTransferSnapshot, targetWindowId?: number) => {
    // Begin terminal buffering if this is a terminal transfer
    if (snapshot.terminalPtyId) {
      beginTerminalTransfer(snapshot.terminalPtyId, targetWindowId ?? -1)
    }

    if (targetWindowId) {
      // Transfer to existing window
      sendToWindow(targetWindowId, PANEL_RECEIVE, snapshot)
      // Track panel metadata for the target window
      setPanelWindowMeta(targetWindowId, snapshot.panel, undefined)
    } else {
      // Refuse creating a new panel window while any Cate window is in
      // macOS native fullscreen — the new window would land in a separate
      // Space and appear as an empty black page. Caller should fall back to
      // keeping the panel in the source window.
      if (anyWindowFullscreen()) return null
      // Create a new panel window and send the transfer there
      const newWin = createWindow({
        type: 'panel',
        panelType: snapshot.panel.type,
        panelId: snapshot.panel.id,
        workspaceId: undefined,
      })

      // Track panel metadata
      setPanelWindowMeta(newWin.id, snapshot.panel, undefined)

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
      try {
        newWin.show()
        newWin.focus()
      } catch {
        /* window may already be destroyed */
      }
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

// In dev mode, use a separate userData directory so dev and production don't collide
if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('userData'), 'Dev'))
}

// In E2E mode, use a fresh tmpdir per launch so Playwright runs are isolated
// from each other and from local dev state. The harness sets CATE_E2E=1.
if (process.env.CATE_E2E === '1') {
  const fs = require('fs') as typeof import('fs')
  const os = require('os') as typeof import('os')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-e2e-'))
  app.setPath('userData', tmp)
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
    if (win.isMinimized()) win.restore()
    win.focus()
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

// Initialize Sentry as early as possible — after settings load (so the opt-out
// is honored) but before any IPC handlers or windows. No-op if DSN unset or
// the user has disabled crash reporting.
initSentry()
initAnalytics()

// Provide the menu module a way to spawn additional main windows without
// importing this file (which would create a circular dependency).
setNewMainWindowFn(() => createWindow({ type: 'main' }))

// ---------------------------------------------------------------------------
// Emergency PTY cleanup — kill child process groups on crash or signal so
// dev servers, watchers, etc. don't survive as zombies keeping ports open.
// Defined before the error handlers that call it.
// ---------------------------------------------------------------------------

function emergencyKillPTYs(): void {
  for (const pid of terminalPids.values()) {
    try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
  }
}

// Global error handlers — Sentry (when configured) captures the error before
// process exit. Also kill PTY process groups so dev servers don't survive.
process.on('uncaughtException', (err) => {
  log.error('uncaughtException: %O', err)
  captureMainException(err)
  emergencyKillPTYs()
  flushSentry().finally(() => process.exit(1))
})
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection: %O', reason)
  captureMainException(reason)
})

process.on('SIGTERM', () => {
  log.info('Received SIGTERM, killing PTY process groups')
  emergencyKillPTYs()
  process.exit(0)
})

process.on('SIGINT', () => {
  log.info('Received SIGINT, killing PTY process groups')
  emergencyKillPTYs()
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
  registerCriticalHandlers()
  log.info('Critical IPC handlers registered')

  await runLegacyMigrationIfNeeded()

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
    // before app_start, so the upgrade path lands in analytics in order.
    checkAndReportUpdate(mainWin).catch((err) => log.warn('Update detection failed:', err))
    trackAppStart()
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
const FLUSH_TIMEOUT_MS = 1500

app.on('before-quit', (event) => {
  if (sessionFlushed) {
    // Second pass — renderer already saved, let quit proceed to will-quit
    log.info('before-quit: session already flushed, proceeding')
    return
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
  // Kill all PTYs now — AFTER session save so the renderer had access to live
  // PTY data (CWD, scrollback) during the flush triggered in before-quit.
  // Must happen while the JS environment is still alive. If we let them die
  // during Environment::CleanupHandles, node-pty's ThreadSafeFunction exit
  // callback throws into a torn-down context and SIGABRTs the process.
  killAllTerminals()
  // When an update install is in flight, DO NOT reallyExit — that bypasses
  // Electron's relaunch hook (queued by autoUpdater.quitAndInstall(_, true)).
  // We need the natural quit path to run so the updater can launch the new
  // version. The PTY/SIGABRT risk we guard against below is only a problem
  // when many native handles are still alive; the updater install path takes
  // over the process shortly anyway, so a plain return is safe here.
  if (isInstallingUpdate()) {
    log.info('will-quit: update install in progress, deferring to Electron relaunch')
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
