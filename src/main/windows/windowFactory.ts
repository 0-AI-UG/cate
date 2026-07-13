import { BrowserWindow, nativeImage, nativeTheme } from 'electron'
import path from 'path'
import log from '../logger'
import { installRendererCrashRecovery } from './crashRecovery'
import { revealWindow } from './reveal'
import { readBootSnapshot, writeBootSnapshot } from '../store'
import {
  registerWindow,
  getWindowType,
  getActiveMainWindow,
  listWindows,
  sendToWindow,
} from '../windowRegistry'
import { stopWatchersForWindow } from '../ipc/filesystem'
import { stopMonitorsForWindow } from '../ipc/git-monitor'
import { stopSearchesForWindow } from '../ipc/search'
import { clearFileGrantsForWindow, clearScopedWriteAllowancesForWindow, grantFileAccess } from '../ipc/pathValidation'
import {
  forwardFileGrant,
  forwardClearFileGrantsForWindow,
  forwardClearScopedWriteAllowancesForWindow,
} from '../runtime/runtimeManager'
import { listPersistentGrants } from '../grantedPathStore'
import { rebuildApplicationMenu } from '../menu'
import { disableRendererSandbox } from '../featureFlags'
import { WINDOW_FULLSCREEN_STATE, WINDOW_MAXIMIZE_STATE, SESSION_FLUSH_SAVE } from '../../shared/ipc-channels'
import { IS_E2E } from './reveal'
import type { CateWindowParams } from '../../shared/types'

export function createWindow(params?: CateWindowParams): BrowserWindow {
  const iconPath = path.join(__dirname, '../../build/icon-1024.png')
  const windowType = params?.type ?? 'main'
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
    width: snapGeom?.width ?? (isDock ? 700 : 1200),
    height: snapGeom?.height ?? (isDock ? 500 : 800),
    x: snapGeom?.x,
    y: snapGeom?.y,
    show: false,
    minWidth: isDock ? 400 : 800,
    minHeight: isDock ? 300 : 600,
    title: 'Cate',
    // macOS: hide the native title bar and draw a themed strip in its place (the
    // macOS native bar can't be tinted to a theme color — only dark/light — so we
    // always use `hiddenInset` and render TitlebarStrip).
    // Windows/Linux: go fully frameless and draw our own window controls in the
    // renderer (WindowControls), so the chrome matches the theme. `titleBarStyle`
    // is irrelevant once `frame:false`.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Center the traffic lights on the 36px chrome line shared by the dock tab
    // bar, the MacWindowChrome toggle, and the sidebar's top strip (y≈11 for a
    // 36px row). Dock and main windows use the same line so they read alike.
    trafficLightPosition: process.platform !== 'darwin'
      ? undefined
      : isDock
        ? { x: 12, y: 11 }
        : windowType === 'main'
          ? { x: 10, y: 11 }
          : undefined,
    // macOS main windows keep a (hidden-inset) native frame; dock windows — and
    // every window on Windows/Linux — are frameless.
    frame: process.platform === 'darwin' ? !isDock : false,
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

  // Capture ID before window is destroyed (win.id throws after 'closed')
  const windowId = win.id
  let windowRevealed = false
  const revealOnce = (reason: string): void => {
    if (windowRevealed || win.isDestroyed()) return
    windowRevealed = true
    log.info('Revealing window type=%s id=%d via %s', windowType, windowId, reason)
    revealWindow(win)
  }

  // Prefer ready-to-show so the first frame is painted before the window
  // appears. did-finish-load is a safety net for startup paths where
  // ready-to-show never arrives and the hidden window would otherwise stay
  // invisible forever.
  win.once('ready-to-show', () => revealOnce('ready-to-show'))
  win.webContents.once('did-finish-load', () => revealOnce('did-finish-load'))

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

  log.info('Creating window type=%s id=%d', windowType, windowId)

  // Recover from renderer crashes / hangs (OOM, GPU fault, native crash) that
  // React's ErrorBoundary can't see.
  installRendererCrashRecovery(win, windowType, windowId)

  // Re-arm grants for every persisted Save-As path so editors restored in
  // this window (any window type — main, dock) can read+save their
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
          // Mirror the grant into the owning runtime's authoritative map so a
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

  // When the main window is closed, also close any detached dock windows so
  // the app actually quits (otherwise they keep the process alive and
  // `window-all-closed` never fires).
  if (windowType === 'main') {
    win.on('close', () => {
      for (const other of listWindows()) {
        if (other.id === windowId) continue
        const t = getWindowType(other.id)
        if (t === 'dock') {
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
    stopMonitorsForWindow(windowId)
    stopSearchesForWindow(windowId)
    clearScopedWriteAllowancesForWindow(windowId)
    clearFileGrantsForWindow(windowId)
    // Forward the clears to every registered runtime (the daemon keeps its own
    // grant maps; a window close has no locator, so fan out to all hosts).
    forwardClearScopedWriteAllowancesForWindow(windowId)
    forwardClearFileGrantsForWindow(windowId)
    // Rebuild menu to update the dock window list
    if (isDock) rebuildApplicationMenu()
    // Trigger immediate session save from main window when a child window closes
    if (windowType !== 'main') {
      const mainWin = getActiveMainWindow()
      if (mainWin) {
        sendToWindow(mainWin.id, SESSION_FLUSH_SAVE)
      }
    }
  })

  // Rebuild menu when dock windows are created
  if (isDock) {
    win.webContents.once('did-finish-load', () => {
      rebuildApplicationMenu()
    })
  }

  // Push *this* window's own fullscreen state to *its own* renderer so each
  // window's chrome (the macOS window-control island / dock tab-bar dot
  // reservation) collapses only when that window itself is fullscreen — not
  // when some other window is. Consumers that genuinely need "is ANY window
  // fullscreen" (drag-to-detach refusal) use the sync `anyWindowFullscreen`
  // getter instead. The authoritative sync IPC handler is registered once
  // below; these pushes cover listeners that want live updates.
  const sendFullscreen = (value: boolean): void => {
    sendToWindow(win.id, WINDOW_FULLSCREEN_STATE, value)
  }
  win.on('enter-full-screen', () => sendFullscreen(true))
  win.on('leave-full-screen', () => sendFullscreen(false))
  // Fire at the *start* of the transition too so the renderer can hide the
  // chrome drag-region before macOS begins its slide animation, instead of
  // waiting for the post-animation enter/leave events.
  // macOS-only events; cast to sidestep missing type overloads.
  ;(win as unknown as { on: (e: string, fn: () => void) => void }).on('will-enter-full-screen', () => sendFullscreen(true))
  ;(win as unknown as { on: (e: string, fn: () => void) => void }).on('will-leave-full-screen', () => sendFullscreen(false))
  win.webContents.once('did-finish-load', () => sendFullscreen(win.isFullScreen()))

  // Push this window's own maximize state to its renderer so the custom window
  // controls (WindowControls, Windows/Linux) can swap the maximize/restore glyph.
  // Per-window (not broadcast): each window's maximize state is independent.
  const sendMaximizeState = (): void => {
    if (win.isDestroyed()) return
    sendToWindow(win.id, WINDOW_MAXIMIZE_STATE, win.isMaximized())
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
