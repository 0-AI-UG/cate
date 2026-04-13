import log from './logger'
import { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, screen, webContents, session } from 'electron'
import fs from 'fs'
import path from 'path'
import { SHELL_SHOW_IN_FOLDER, HTTP_FETCH, WEBVIEW_SCREENSHOT, NATIVE_FILE_DRAG, CAPTURE_PAGE, DIALOG_OPEN_FOLDER, DIALOG_SAVE_FILE, DIALOG_CONFIRM_UNSAVED, DIALOG_CONFIRM_CLOSE_CANVAS, CRASH_REPORT_SAVE } from '../shared/ipc-channels'
import {
  WINDOW_CREATE, WINDOW_GET_ID, WINDOW_GET_TYPE, WINDOW_SET_TITLE,
  PANEL_TRANSFER, PANEL_RECEIVE, PANEL_TRANSFER_ACK,
  PANEL_WINDOWS_LIST, PANEL_WINDOW_DOCK_BACK, PANEL_WINDOW_SYNC_PTY,
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
import { registerHandlers as registerStoreHandlers, getLastSavedSession, saveSessionSync, loadSettingsSyncFromDisk, getSettingSync } from './store'
import { registerHandlers as registerMCPHandlers } from './ipc/mcp'
import { registerHandlers as registerMenuHandlers } from './ipc/menu'
import { registerHandlers as registerNotificationHandlers } from './ipc/notifications'
import { writeDragTempFile, cleanupDragTempFile, createDragGhostImage } from './ipc/drag'
import { registerWindow, getWindowType, sendToWindow, broadcastToAll, broadcastToAllExcept, setPanelWindowMeta, setPanelWindowTerminalPtyId, listPanelWindows, getWindow, setDockWindowState, listDockWindows } from './windowRegistry'
import { registerWorkspaceHandlers } from './workspaceManager'
import { registerUsageHandlers, disposeUsageWatchers } from './ipc/usage'
import { addAllowedRoot, validatePath } from './ipc/pathValidation'
import { buildApplicationMenu, rebuildApplicationMenu, setNewMainWindowFn } from './menu'
import { initShellEnv } from './shellEnv'
import { initAutoUpdater } from './auto-updater'
import { saveCrashReport, checkPendingCrashReport } from './crashReporter'
import { beginTerminalTransfer, acknowledgeTerminalTransfer } from './ipc/terminal'
import type { CateWindowParams, DockWindowInitPayload, PanelState, PanelTransferSnapshot, WindowDockState } from '../shared/types'

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

function createWindow(params?: CateWindowParams): BrowserWindow {
  const iconPath = path.join(__dirname, '../../build/icon-1024.png')
  const windowType = params?.type ?? 'main'
  const isPanel = windowType === 'panel'
  const isDock = windowType === 'dock'

  const win = new BrowserWindow({
    width: isDock ? 700 : isPanel ? 700 : 1200,
    height: isDock ? 500 : isPanel ? 500 : 800,
    minWidth: isDock ? 400 : isPanel ? undefined : 800,
    minHeight: isDock ? 300 : isPanel ? undefined : 600,
    title: isDock ? 'Cate' : isPanel ? 'Cate Panel' : 'Cate',
    // macOS native window tabs require a standard title bar — `hiddenInset`
    // suppresses the tab bar entirely. When native tabs are enabled for main
    // windows we fall back to the default title bar so the tab strip (app
    // name tab + "+" button) can render.
    titleBarStyle: isPanel
      ? 'hidden'
      : (process.platform === 'darwin' && windowType === 'main' && getSettingSync('nativeTabs'))
        ? 'default'
        : 'hiddenInset',
    trafficLightPosition: isDock ? { x: 12, y: 11 } : undefined,
    frame: !(isPanel || isDock),
    // macOS native window tabs — only on main windows. Setting tabbingIdentifier
    // makes new windows in this group join as native tabs in the title bar
    // (subject to System Settings → Desktop & Dock → "Prefer tabs"). Panel and
    // dock windows are excluded so they stay free-floating.
    ...(process.platform === 'darwin' && windowType === 'main' && getSettingSync('nativeTabs')
      ? { tabbingIdentifier: 'cate-main' }
      : {}),
    backgroundColor: '#1f1e1c',
    icon: nativeImage.createFromPath(iconPath),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  })

  // Track this window in the registry with its type
  registerWindow(win, windowType)

  // Capture ID before window is destroyed (win.id throws after 'closed')
  const windowId = win.id
  log.info('Creating window type=%s id=%d', windowType, windowId)

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
  if (params?.panelType) queryParts.push(`panelType=${encodeURIComponent(params.panelType)}`)
  if (params?.panelId) queryParts.push(`panelId=${encodeURIComponent(params.panelId)}`)
  if (params?.workspaceId) queryParts.push(`workspaceId=${encodeURIComponent(params.workspaceId)}`)
  const query = queryParts.length > 0 ? `?${queryParts.join('&')}` : ''

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}${query}`)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'), {
      search: query ? query.slice(1) : undefined,
    })
  }

  return win
}

// =============================================================================
// Drag ghost window — a tiny borderless always-on-top window that follows the
// cursor during cross-window drags so the user has visual feedback outside any
// app window.
// =============================================================================

let dragGhostWin: BrowserWindow | null = null

function createDragGhostWindow(panelType: string, panelTitle: string): void {
  if (dragGhostWin && !dragGhostWin.isDestroyed()) {
    dragGhostWin.destroy()
  }

  dragGhostWin = new BrowserWindow({
    width: 200,
    height: 32,
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

  // Ignore mouse events so the ghost doesn't interfere with drop targets
  dragGhostWin.setIgnoreMouseEvents(true)

  // Render a simple HTML pill as the ghost
  const iconMap: Record<string, string> = {
    terminal: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgb(77,217,100)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
    browser: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgb(74,158,255)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
    editor: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgb(255,159,10)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    git: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgb(255,59,48)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>',
    fileExplorer: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgb(90,200,250)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    projectList: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgb(255,214,10)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
    canvas: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgb(191,90,242)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>',
  }
  const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
  const icon = iconMap[panelType] || iconMap['editor']
  const safeTitle = escapeHtml(panelTitle.slice(0, 30))
  const html = `data:text/html;charset=utf-8,<!DOCTYPE html>
<html><head><style>
  * { margin: 0; padding: 0; }
  body { background: transparent; overflow: hidden; -webkit-app-region: no-drag; }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px;
    background: rgba(42,42,58,0.95); border: 1px solid rgba(74,158,255,0.4);
    border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    font: 12px -apple-system, sans-serif; color: rgba(255,255,255,0.8);
    white-space: nowrap; }
  .pill svg { flex-shrink: 0; }
</style></head><body><div class="pill"><span>${icon}</span><span>${safeTitle}</span></div></body></html>`

  dragGhostWin.loadURL(html)
  dragGhostWin.webContents.once('did-finish-load', () => {
    if (dragGhostWin && !dragGhostWin.isDestroyed()) {
      dragGhostWin.showInactive()
    }
  })
}

function moveDragGhostWindow(screenX: number, screenY: number): void {
  if (dragGhostWin && !dragGhostWin.isDestroyed()) {
    dragGhostWin.setPosition(screenX + 12, screenY + 12, false)
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

function registerAllHandlers(): void {
  registerTerminalHandlers()
  registerFilesystemHandlers()
  registerGitHandlers()
  registerShellHandlers()
  registerGitMonitorHandlers()
  registerStoreHandlers()
  registerMCPHandlers()
  registerMenuHandlers()
  registerNotificationHandlers()
  registerWorkspaceHandlers()
  registerUsageHandlers()

  // Crash reporting: renderer can save a crash report via IPC
  ipcMain.handle(CRASH_REPORT_SAVE, async (_event, error: { name?: string; message: string; stack?: string }) => {
    saveCrashReport(
      { name: error.name ?? 'Error', message: error.message, stack: error.stack },
      'renderer',
    )
  })

  // Shell: Reveal in Finder
  ipcMain.handle(SHELL_SHOW_IN_FOLDER, async (_event, filePath: string) => {
    try {
      shell.showItemInFolder(validatePath(filePath))
    } catch (error) {
      log.error('[SHELL_SHOW_IN_FOLDER]', error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  // HTTP: Fetch from main process (no CORS)
  ipcMain.handle(HTTP_FETCH, async (_event, url: string): Promise<{ ok: boolean; status: number; text: string }> => {
    try {
      const u = new URL(url)
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http(s) URLs allowed')
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15000)
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Cate/1.0' },
      })
      clearTimeout(timeout)
      const text = await res.text()
      return { ok: res.ok, status: res.status, text }
    } catch (err: any) {
      return { ok: false, status: 0, text: err.message || 'Fetch failed' }
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

  ipcMain.handle(DIALOG_SAVE_FILE, async (_event, options: { defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }) => {
    const result = await dialog.showSaveDialog({
      defaultPath: options.defaultPath,
      filters: options.filters || [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return null
    return result.filePath
  })

  // Native unsaved-changes confirmation. Returns 'save' | 'discard' | 'cancel'.
  ipcMain.handle(DIALOG_CONFIRM_UNSAVED, async (event, payload: { fileName?: string; multiple?: boolean }) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const name = payload?.fileName ?? 'this file'
    const message = payload?.multiple
      ? `Do you want to save the changes you made to ${payload?.fileName ?? 'these files'}?`
      : `Do you want to save the changes you made to ${name}?`
    const result = await dialog.showMessageBox(win!, {
      type: 'warning',
      message,
      detail: "Your changes will be lost if you don't save them.",
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    })
    return result.response === 0 ? 'save' : result.response === 1 ? 'discard' : 'cancel'
  })

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

  // Window management
  ipcMain.handle(WINDOW_CREATE, async (_event, params?: CateWindowParams) => {
    // Refuse new panel/dock windows while any window is fullscreen — they
    // would land in a separate Space and appear as a black page.
    if (anyWindowFullscreen() && params?.type !== 'main') return null
    const win = createWindow(params)
    return win.id
  })

  ipcMain.handle(WINDOW_GET_ID, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.id ?? null
  })

  ipcMain.handle(WINDOW_GET_TYPE, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    return getWindowType(win.id) ?? 'main'
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

    // Refuse to create a new window while any Cate window is in macOS
    // native fullscreen — the new window would land in a different Space
    // (black screen). Caller treats a null return as "detach rejected —
    // put the panel back where it came from".
    if (anyWindowFullscreen()) return null

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

    // Position at cursor
    const display = screen.getDisplayNearestPoint(cursor)
    newWin.setBounds({
      x: cursor.x - display.bounds.x,
      y: cursor.y - display.bounds.y,
      width: snapshot.geometry?.size?.width ?? 700,
      height: snapshot.geometry?.size?.height ?? 500,
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

  // Cross-window drag coordination
  let crossWindowDragState: {
    snapshot: PanelTransferSnapshot
    sourceWindowId: number
    pollTimer: ReturnType<typeof setInterval> | null
  } | null = null

  // Used by CROSS_WINDOW_DRAG_RESOLVE to detect if a target window claimed the drop
  let crossWindowDropClaimed = false
  let crossWindowDropClaimedResolve: (() => void) | null = null

  ipcMain.handle(CROSS_WINDOW_DRAG_START, async (event, snapshot: PanelTransferSnapshot, _screenPos: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return

    // Refuse any cross-window drag while any Cate window is in macOS
    // native fullscreen — the drag ghost would land in a different Space
    // (black window). Lock the drag to the source window entirely.
    if (anyWindowFullscreen()) return

    crossWindowDragState = {
      snapshot,
      sourceWindowId: win.id,
      pollTimer: null,
    }

    // Create the native drag ghost window
    createDragGhostWindow(snapshot.panel.type, snapshot.panel.title)

    // Poll cursor position: move ghost, broadcast to all windows EXCEPT source
    crossWindowDragState.pollTimer = setInterval(() => {
      if (!crossWindowDragState) return
      const pos = screen.getCursorScreenPoint()
      moveDragGhostWindow(pos.x, pos.y)
      broadcastToAllExcept(crossWindowDragState.sourceWindowId, CROSS_WINDOW_DRAG_UPDATE, pos, crossWindowDragState.snapshot)
    }, 33) // ~30fps
  })

  ipcMain.handle(CROSS_WINDOW_DRAG_DROP, async (event, _panelId: string) => {
    if (crossWindowDragState) {
      if (crossWindowDragState.pollTimer) {
        clearInterval(crossWindowDragState.pollTimer)
      }
      // Notify source window to remove the panel
      sendToWindow(crossWindowDragState.sourceWindowId, DRAG_END)
      crossWindowDragState = null
    }
    destroyDragGhostWindow()

    // Signal the resolve handler that a target window claimed the drop
    if (crossWindowDropClaimedResolve) {
      crossWindowDropClaimedResolve()
    } else {
      crossWindowDropClaimed = true
    }
  })

  ipcMain.handle(CROSS_WINDOW_DRAG_CANCEL, async () => {
    if (!crossWindowDragState) return
    if (crossWindowDragState.pollTimer) {
      clearInterval(crossWindowDragState.pollTimer)
    }
    crossWindowDragState = null
    destroyDragGhostWindow()
    broadcastToAll(DRAG_END)
  })

  // Resolve cross-window drag on mouseup from source window.
  // Broadcasts DRAG_END, waits briefly for a target window to claim via crossWindowDragDrop,
  // then returns whether the drop was claimed. If not, source falls back to dragDetach.
  ipcMain.handle(CROSS_WINDOW_DRAG_RESOLVE, async () => {
    if (!crossWindowDragState) return { claimed: false }

    const sourceId = crossWindowDragState.sourceWindowId

    // Stop polling
    if (crossWindowDragState.pollTimer) {
      clearInterval(crossWindowDragState.pollTimer)
      crossWindowDragState.pollTimer = null
    }

    // Mark as resolving — crossWindowDragDrop will set claimed flag
    crossWindowDragState = null
    destroyDragGhostWindow()

    // Broadcast DRAG_END to non-source windows so target windows check their drop targets
    broadcastToAllExcept(sourceId, DRAG_END)

    // Wait briefly for a target window to call crossWindowDragDrop
    return new Promise<{ claimed: boolean }>((resolve) => {
      // Check if already claimed (race condition guard)
      if (crossWindowDropClaimed) {
        crossWindowDropClaimed = false
        resolve({ claimed: true })
        return
      }

      // Set up a short timeout — if no window claims within 80ms, report unclaimed
      const timeout = setTimeout(() => {
        crossWindowDropClaimedResolve = null
        crossWindowDropClaimed = false
        resolve({ claimed: false })
      }, 80)

      // Store resolver so crossWindowDragDrop can trigger it
      crossWindowDropClaimedResolve = () => {
        clearTimeout(timeout)
        crossWindowDropClaimedResolve = null
        crossWindowDropClaimed = false
        resolve({ claimed: true })
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

// Build application menu
buildApplicationMenu()

log.info('Cate v%s starting (electron %s, node %s, platform %s)', app.getVersion(), process.versions.electron, process.versions.node, process.platform)

// Load persisted settings synchronously so window-creation code paths can read
// them before the async electron-store finishes initializing.
loadSettingsSyncFromDisk()

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

// Global error handlers — save a crash report to disk so the user can opt-in
// to sending it on next launch. Also kill PTY process groups.
process.on('uncaughtException', (err) => {
  log.error('uncaughtException: %O', err)
  saveCrashReport(err, 'main')
  emergencyKillPTYs()
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection: %O', reason)
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
  log.info('App ready, resolving shell environment...')

  // Resolve the user's real shell environment before registering handlers.
  // This ensures MCP servers, `which` lookups, etc. see the full PATH.
  await initShellEnv()
  log.info('Shell environment resolved')

  // Register the user's home directory as an allowed root so workspace paths
  // under ~ are accessible. The Desktop is also allowed for screenshot saves.
  addAllowedRoot(app.getPath('home'))

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const origin = details.url
    if (origin.startsWith('file://') || (process.env.ELECTRON_RENDERER_URL && origin.startsWith(process.env.ELECTRON_RENDERER_URL))) {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            `default-src 'self'; script-src 'self'${process.env.ELECTRON_RENDERER_URL ? " 'unsafe-inline' 'unsafe-eval'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https: ws: wss:; font-src 'self' data:; base-uri 'self'`,
          ],
        },
      })
    } else {
      callback({})
    }
  })

  registerAllHandlers()
  log.info('IPC handlers registered')

  const mainWin = createWindow({ type: 'main' })
  log.info('Main window created (id=%d)', mainWin.id)

  initAutoUpdater()

  // Check for a crash report from the previous session — shows an opt-in
  // dialog if one exists. Deferred until after the window is ready so the
  // dialog has a parent window and doesn't block startup.
  mainWin.once('ready-to-show', () => {
    checkPendingCrashReport().catch((err) => log.warn('Crash report check failed:', err))
  })
})

app.on('window-all-closed', () => {
  log.info('All windows closed, quitting')
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow({ type: 'main' })
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
const FLUSH_TIMEOUT_MS = 3000

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
  log.info('will-quit: sync session save fallback')
  saveSessionSync(getLastSavedSession())
  // Close usage file watchers and clear caches to release file descriptors
  disposeUsageWatchers()
  // Kill all PTYs now — AFTER session save so the renderer had access to live
  // PTY data (CWD, scrollback) during the flush triggered in before-quit.
  // Must happen while the JS environment is still alive. If we let them die
  // during Environment::CleanupHandles, node-pty's ThreadSafeFunction exit
  // callback throws into a torn-down context and SIGABRTs the process.
  killAllTerminals()
  // Force immediate exit via _exit(0) to bypass node::FreeEnvironment →
  // CleanupHandles → uv_run, which drains pending ThreadSafeFunction
  // callbacks. Even app.exit(0) eventually calls process.exit() which runs
  // that cleanup path, so we must use the raw _exit() to truly skip it.
  // All important cleanup (session save, logger flush, watcher disposal,
  // process group kills) is already done above.
  ;(process as unknown as { _exit(code: number): never })._exit(0)
})

