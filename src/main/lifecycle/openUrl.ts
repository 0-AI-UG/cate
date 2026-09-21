import { app, ipcMain, type BrowserWindow, type WebContents } from 'electron'
import { APP_OPEN_URL, APP_OPEN_URL_READY } from '../../shared/ipc-channels'
import { isWebUrl } from '../../shared/webUrl'
import { focusWindow, getActiveMainWindow, getWindowType, sendToWindow, windowFromEvent } from '../windowRegistry'
import { IS_E2E } from '../windows/reveal'

/** Register before app readiness. Renderer readiness is separate from native
 * ready-to-show: session restoration must finish before adding browser panels. */
export function registerOpenUrlHandler(createMainWindow: () => BrowserWindow): void {
  const pending: string[] = []
  const ready = new WeakSet<WebContents>()
  const tracked = new WeakSet<WebContents>()
  let started = false

  const flush = (win: BrowserWindow): void => {
    if (!ready.has(win.webContents) || win.isDestroyed()) return
    if (pending.length && !IS_E2E) focusWindow(win)
    for (const url of pending.splice(0)) sendToWindow(win.id, APP_OPEN_URL, url)
  }

  ipcMain.on(APP_OPEN_URL_READY, (event, listening: unknown) => {
    const win = windowFromEvent(event)
    if (!win || getWindowType(win.id) !== 'main' || event.senderFrame !== event.sender.mainFrame) return
    if (listening !== true) {
      ready.delete(event.sender)
      return
    }
    if (!tracked.has(event.sender)) {
      tracked.add(event.sender)
      event.sender.on('did-start-loading', () => ready.delete(event.sender))
    }
    ready.add(event.sender)
    started = true
    flush(win)
  })

  app.on('open-url', (event, url) => {
    event.preventDefault()
    if (!isWebUrl(url)) return
    pending.push(url)
    // app.ready can precede asynchronous bootstrap and IPC registration. Let
    // bootstrap create the first window; only recreate one after startup.
    const win = getActiveMainWindow() ?? (started && app.isReady() ? createMainWindow() : undefined)
    if (win) flush(win)
  })
}
