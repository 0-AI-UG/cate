// Creates the app's BrowserWindows: main windows and the native windows of
// detached document windows (opened on request of the renderer's windows
// port). Main window bounds and the theme boot cache come from `boot.json` so
// the first frame matches the final UI.

import path from 'node:path'
import { BrowserWindow, dialog, nativeImage, nativeTheme } from 'electron'
import { createLogger } from '@kernel/log/contract'
import { DESKTOP_CHANNELS as C, type Bounds, type DetachedWindowRef, type WindowState } from '../contract'
import { installCrashRecovery } from './crashRecovery'
import type { DeviceFiles } from './deviceFiles'
import { featureFlags, IS_E2E, revealWindow } from './env'
import type { WindowRegistry } from './windowRegistry'

const log = createLogger('windows')

const DEFAULT_BACKGROUND = '#1f1e1c'
const BOUNDS_DEBOUNCE_MS = 300
/** A detached window whose renderer does not act on a close request closes
 *  on the next attempt after this long. */
const CLOSE_REQUEST_GRACE_MS = 3_000

export interface WindowFactoryOptions {
  registry: WindowRegistry<BrowserWindow>
  device: DeviceFiles
  preload: string
  /** Dev server URL, else the built renderer's index.html. */
  rendererUrl?: string
  rendererFile: string
  icon: string
  /** True once a quit has passed its gates; windows then close for real. */
  quitCommitted(): boolean
  requestQuit(): void
  report(message: string, extra: Record<string, unknown>): void
}

export interface WindowFactory {
  createMainWindow(): BrowserWindow
  openDetached(ref: DetachedWindowRef, bounds?: Bounds): BrowserWindow
  /** Closes a detached window without asking its renderer. */
  closeDetached(ref: DetachedWindowRef): void
}

function windowState(win: BrowserWindow): WindowState {
  return { fullscreen: win.isFullScreen(), maximized: win.isMaximized(), focused: win.isFocused() }
}

export function createWindowFactory(options: WindowFactoryOptions): WindowFactory {
  const { registry, device } = options
  const allowClose = new WeakSet<BrowserWindow>()

  // CATE_FAKE_PLATFORM previews another platform's window chrome from a Mac.
  const fakePlatform = process.env.CATE_FAKE_PLATFORM
  const platform = fakePlatform || process.platform
  const macChrome = platform === 'darwin'

  const build = (kind: 'main' | 'detached', ref?: DetachedWindowRef, bounds?: Bounds): BrowserWindow => {
    const boot = kind === 'main' ? device.boot() : null
    const geometry = kind === 'main' ? boot?.geometry : bounds
    const background = boot?.backgroundColor ?? DEFAULT_BACKGROUND
    if (boot?.appearance) {
      try { nativeTheme.themeSource = boot.appearance } catch { /* noop */ }
    }
    const detached = kind === 'detached'
    const win = new BrowserWindow({
      width: geometry?.width ?? (detached ? 700 : 1200),
      height: geometry?.height ?? (detached ? 500 : 800),
      x: geometry?.x,
      y: geometry?.y,
      show: false,
      minWidth: detached ? 400 : 800,
      minHeight: detached ? 300 : 600,
      title: 'Cate',
      titleBarStyle: macChrome ? 'hidden' : 'default',
      trafficLightPosition: macChrome ? (detached ? { x: 12, y: 11 } : { x: 10, y: 11 }) : undefined,
      // Windows and Linux draw their own window controls in the renderer.
      frame: macChrome ? !detached : false,
      backgroundColor: macChrome && !detached ? '#00000000' : background,
      ...(macChrome && !detached ? { vibrancy: 'sidebar' as const } : {}),
      icon: nativeImage.createFromPath(options.icon),
      webPreferences: {
        preload: options.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: !featureFlags.disableRendererSandbox(),
        webSecurity: true,
        webviewTag: true,
        // Hidden page drivers must keep answering while the window is in the background.
        backgroundThrottling: false,
        ...(IS_E2E ? { paintWhenInitiallyHidden: true } : {}),
      },
    })
    const id = win.id
    registry.register(win, kind, ref)
    log.info('created %s window %d', kind, id)

    let revealed = false
    const reveal = () => {
      if (revealed || win.isDestroyed()) return
      revealed = true
      revealWindow(win)
    }
    win.once('ready-to-show', reveal)
    win.webContents.once('did-finish-load', reveal)

    installCrashRecovery(win, kind, {
      showMessageBox: (parent, opts) => dialog.showMessageBox(parent, opts),
      report: options.report,
    })

    const sendState = () => { if (!win.isDestroyed()) win.webContents.send(C.windowStateChanged, windowState(win)) }
    for (const event of ['enter-full-screen', 'leave-full-screen', 'maximize', 'unmaximize', 'focus', 'blur'] as const) {
      win.on(event as 'focus', sendState)
    }
    // Before the macOS slide animation starts, so chrome can hide its drag region early.
    ;(win as unknown as { on(e: string, fn: () => void): void }).on('will-enter-full-screen', () => {
      if (!win.isDestroyed()) win.webContents.send(C.windowStateChanged, { ...windowState(win), fullscreen: true })
    })
    ;(win as unknown as { on(e: string, fn: () => void): void }).on('will-leave-full-screen', () => {
      if (!win.isDestroyed()) win.webContents.send(C.windowStateChanged, { ...windowState(win), fullscreen: false })
    })
    win.webContents.on('did-finish-load', sendState)

    let boundsTimer: ReturnType<typeof setTimeout> | null = null
    const onBounds = () => {
      if (boundsTimer) clearTimeout(boundsTimer)
      boundsTimer = setTimeout(() => {
        boundsTimer = null
        if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
        const next = win.getBounds()
        if (kind === 'main') device.updateBoot({ geometry: next })
        else win.webContents.send(C.windowBounds, next)
      }, BOUNDS_DEBOUNCE_MS)
    }
    win.on('move', onBounds)
    win.on('resize', onBounds)

    if (kind === 'main') {
      win.on('close', (event) => {
        // Closing the last main window is quitting: run the quit sequence while
        // this window is alive so its confirmation has a parent.
        const lastMain = !registry.list().some((entry) => entry.kind === 'main' && entry.win.id !== id)
        if (lastMain && !options.quitCommitted()) {
          event.preventDefault()
          options.requestQuit()
          return
        }
        if (lastMain) {
          // close() rather than destroy(): destroy tears down webviews without
          // unloading them and crashes the GPU process on quit.
          for (const entry of registry.list()) {
            if (entry.kind === 'detached') try { entry.win.close() } catch { /* noop */ }
          }
        }
      })
    } else {
      let requestedAt = 0
      win.on('close', (event) => {
        if (options.quitCommitted() || allowClose.has(win)) return
        const now = Date.now()
        if (requestedAt && now - requestedAt > CLOSE_REQUEST_GRACE_MS) return
        // Closing a detached window is a document op; its renderer applies it
        // and the windows port then closes this window.
        event.preventDefault()
        if (!requestedAt) requestedAt = now
        win.webContents.send(C.windowCloseRequested)
      })
    }

    const query = new URLSearchParams({ window: kind })
    if (ref) {
      query.set('workspaceId', ref.workspaceId)
      query.set('windowId', ref.windowId)
    }
    if (kind === 'main') query.set('bg', background)
    if (fakePlatform) query.set('platform', platform)
    if (options.rendererUrl) void win.loadURL(`${options.rendererUrl}?${query}`)
    else void win.loadFile(options.rendererFile, { search: query.toString() })
    return win
  }

  return {
    createMainWindow: () => build('main'),
    openDetached(ref, bounds) {
      const existing = registry.findDetached(ref)
      if (existing) {
        revealWindow(existing.win, { focus: true })
        return existing.win
      }
      return build('detached', ref, bounds)
    },
    closeDetached(ref) {
      const entry = registry.findDetached(ref)
      if (!entry) return
      allowClose.add(entry.win)
      try { entry.win.close() } catch { /* noop */ }
    },
  }
}

/** Where the built renderer, preload and icon live relative to the main bundle. */
export function shellPaths(mainDir: string): { preload: string; rendererFile: string; icon: string } {
  return {
    preload: path.join(mainDir, '../preload/shell.js'),
    rendererFile: path.join(mainDir, '../renderer/index.html'),
    icon: path.join(mainDir, '../../build/icon-1024.png'),
  }
}
