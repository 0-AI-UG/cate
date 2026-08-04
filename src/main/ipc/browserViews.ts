import { BrowserWindow, ipcMain, session, WebContentsView } from 'electron'
import type { Rectangle } from 'electron'
import {
  BROWSER_VIEW_BOUNDS,
  BROWSER_VIEW_COMMAND,
  BROWSER_VIEW_CREATE,
  BROWSER_VIEW_DESTROY,
  BROWSER_VIEW_EVENT,
  BROWSER_VIEW_GUEST_MESSAGE,
} from '../../shared/ipc-channels'
import type {
  BrowserViewCommand,
  BrowserViewEvent,
  BrowserViewLayout,
  BrowserViewState,
} from '../../shared/electron-api'
import { wrapHandler } from './handlerError'
import {
  configureBrowserGuestSession,
  getBrowserGuestPreloadPath,
  installBrowserGuestContents,
} from '../webSecurity'
import { watchDownloadsForSession } from './browserControl'
import {
  registerBrowserViewOwner,
  unregisterBrowserViewOwner,
} from '../browser/browserViewOwnership'

interface Entry {
  owner: BrowserWindow
  panelId: string
  view: WebContentsView
  bounds: Rectangle | null
  zoomFactor: number
}

const entries = new Map<string, Entry>()
const entriesByWebContents = new Map<number, Entry>()
const watchedOwners = new WeakSet<BrowserWindow>()

function key(owner: BrowserWindow, panelId: string, webContentsId: number): string {
  return `${owner.id}:${panelId}:${webContentsId}`
}

function ownerFromSender(sender: Electron.WebContents): BrowserWindow | null {
  const owner = BrowserWindow.fromWebContents(sender)
  return owner && !owner.isDestroyed() ? owner : null
}

function stateOf(entry: Entry): BrowserViewState {
  const contents = entry.view.webContents
  return {
    webContentsId: contents.id,
    url: contents.getURL(),
    title: contents.getTitle(),
    loading: contents.isLoading(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
  }
}

function send(entry: Entry, event: Omit<BrowserViewEvent, 'panelId' | 'webContentsId'>): void {
  if (entry.owner.isDestroyed() || entry.owner.webContents.isDestroyed()) return
  entry.owner.webContents.send(BROWSER_VIEW_EVENT, {
    panelId: entry.panelId,
    webContentsId: entry.view.webContents.id,
    ...event,
  })
}

function destroyEntry(entry: Entry): void {
  entries.delete(key(entry.owner, entry.panelId, entry.view.webContents.id))
  entriesByWebContents.delete(entry.view.webContents.id)
  unregisterBrowserViewOwner(entry.view.webContents.id)
  try { entry.owner.contentView.removeChildView(entry.view) } catch { /* owner closing */ }
  if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close()
}

function destroyEntriesForOwner(owner: BrowserWindow): void {
  for (const entry of [...entries.values()]) {
    if (entry.owner === owner) destroyEntry(entry)
  }
}

function watchOwner(owner: BrowserWindow): void {
  if (watchedOwners.has(owner)) return
  watchedOwners.add(owner)
  owner.once('closed', () => destroyEntriesForOwner(owner))
  owner.webContents.on('did-start-navigation', (_event, _url, isSameDocument, isMainFrame) => {
    if (isMainFrame && !isSameDocument) destroyEntriesForOwner(owner)
  })
  owner.webContents.on('render-process-gone', () => destroyEntriesForOwner(owner))
  owner.webContents.once('destroyed', () => destroyEntriesForOwner(owner))
}

function bindEvents(entry: Entry): void {
  const contents = entry.view.webContents
  contents.on('dom-ready', () => send(entry, { type: 'dom-ready' }))
  contents.on('did-navigate', (_event, url) => send(entry, { type: 'did-navigate', url, state: stateOf(entry) }))
  contents.on('did-navigate-in-page', (_event, url) => send(entry, { type: 'did-navigate-in-page', url, state: stateOf(entry) }))
  contents.on('page-favicon-updated', (_event, favicons) => send(entry, { type: 'page-favicon-updated', favicons }))
  contents.on('page-title-updated', (_event, title) => send(entry, { type: 'page-title-updated', title, state: stateOf(entry) }))
  contents.on('did-fail-load', (_event, errorCode, errorDescription, url, isMainFrame) => {
    send(entry, { type: 'did-fail-load', errorCode, errorDescription, url, isMainFrame })
  })
  contents.on('did-start-loading', () => send(entry, { type: 'did-start-loading', state: stateOf(entry) }))
  contents.on('did-stop-loading', () => send(entry, { type: 'did-stop-loading', state: stateOf(entry) }))
  contents.on('render-process-gone', (_event, details) => {
    send(entry, { type: 'render-process-gone', reason: details.reason })
  })
  contents.on('before-mouse-event', (event, input) => {
    const modifiers = input.modifiers ?? []
    const canvasZoom = input.type === 'mouseWheel'
      && modifiers.some((modifier) => (
        modifier === 'control'
        || modifier === 'ctrl'
        || modifier === 'meta'
        || modifier === 'command'
        || modifier === 'cmd'
      ))
    if (!canvasZoom || !entry.bounds || entry.owner.webContents.isDestroyed()) return
    event.preventDefault()
    entry.owner.webContents.sendInputEvent({
      ...input,
      x: entry.bounds.x + input.x,
      y: entry.bounds.y + input.y,
    })
  })
}

function applyLayout(entry: Entry, layout: BrowserViewLayout): void {
  const rendererWidth = Math.max(1, layout.rendererSize.width)
  const rendererHeight = Math.max(1, layout.rendererSize.height)
  const contentBounds = entry.owner.getContentBounds()
  const scaleX = contentBounds.width / rendererWidth
  const scaleY = contentBounds.height / rendererHeight
  const next = {
    x: Math.round(layout.rect.x * scaleX),
    y: Math.round(layout.rect.y * scaleY),
    width: Math.max(1, Math.round(layout.rect.width * scaleX)),
    height: Math.max(1, Math.round(layout.rect.height * scaleY)),
  }
  if (!entry.bounds
    || entry.bounds.x !== next.x
    || entry.bounds.y !== next.y
    || entry.bounds.width !== next.width
    || entry.bounds.height !== next.height) {
    entry.view.setBounds(next)
    entry.bounds = next
  }
  if (entry.zoomFactor !== layout.zoomFactor) {
    entry.view.webContents.setZoomFactor(layout.zoomFactor)
    entry.zoomFactor = layout.zoomFactor
  }
  entry.view.setVisible(layout.visible && next.width > 1 && next.height > 1)
}

export function registerBrowserViewHandlers(): void {
  ipcMain.handle(BROWSER_VIEW_CREATE, wrapHandler(`[${BROWSER_VIEW_CREATE}]`, async (event, request: { panelId: string; partition: string }) => {
    const owner = ownerFromSender(event.sender)
    if (!owner || !request.panelId || !request.partition) return null
    const targetSession = session.fromPartition(request.partition)
    configureBrowserGuestSession(targetSession)
    watchDownloadsForSession(targetSession)
    const view = new WebContentsView({
      webPreferences: {
        session: targetSession,
        preload: getBrowserGuestPreloadPath(),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    })
    view.setBackgroundColor('#00000000')
    view.setVisible(false)
    const entry: Entry = { owner, panelId: request.panelId, view, bounds: null, zoomFactor: 1 }
    entries.set(key(owner, request.panelId, view.webContents.id), entry)
    entriesByWebContents.set(view.webContents.id, entry)
    registerBrowserViewOwner(view.webContents.id, owner)
    installBrowserGuestContents(view.webContents, owner.webContents)
    bindEvents(entry)
    owner.contentView.addChildView(view)
    watchOwner(owner)
    return stateOf(entry)
  }))

  ipcMain.handle(BROWSER_VIEW_DESTROY, wrapHandler(`[${BROWSER_VIEW_DESTROY}]`, async (event, panelId: string, webContentsId: number) => {
    const owner = ownerFromSender(event.sender)
    const entry = owner ? entries.get(key(owner, panelId, webContentsId)) : undefined
    if (entry?.view.webContents.id === webContentsId) destroyEntry(entry)
  }))

  ipcMain.on(BROWSER_VIEW_BOUNDS, (event, panelId: string, webContentsId: number, layout: BrowserViewLayout) => {
    const owner = ownerFromSender(event.sender)
    const entry = owner ? entries.get(key(owner, panelId, webContentsId)) : undefined
    if (entry?.view.webContents.id === webContentsId) applyLayout(entry, layout)
  })

  ipcMain.handle(BROWSER_VIEW_COMMAND, wrapHandler(`[${BROWSER_VIEW_COMMAND}]`, async (event, panelId: string, webContentsId: number, command: BrowserViewCommand) => {
    const owner = ownerFromSender(event.sender)
    const entry = owner ? entries.get(key(owner, panelId, webContentsId)) : undefined
    if (!entry || entry.view.webContents.isDestroyed()) return null
    const contents = entry.view.webContents
    switch (command.op) {
      case 'loadURL': await contents.loadURL(command.url); return stateOf(entry)
      case 'reload': contents.reload(); return null
      case 'reloadIgnoringCache': contents.reloadIgnoringCache(); return null
      case 'goBack': if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); return null
      case 'goForward': if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); return null
      case 'focus': contents.focus(); return null
      case 'executeJavaScript': return contents.executeJavaScript(command.code)
      case 'sendInputEvent': contents.sendInputEvent(command.event); return null
      case 'capturePage': {
        const image = await contents.capturePage()
        // This capture is only a transient canvas-motion preview. JPEG avoids
        // the much heavier PNG data URL encode while preserving enough detail
        // for the few frames where the native surface is hidden.
        return image.isEmpty()
          ? null
          : `data:image/jpeg;base64,${image.toJPEG(72).toString('base64')}`
      }
      case 'getState': return stateOf(entry)
    }
  }))

  ipcMain.on(BROWSER_VIEW_GUEST_MESSAGE, (event, channel: string, payload: unknown) => {
    if (channel !== 'cate-browser-password-focus') return
    const entry = entriesByWebContents.get(event.sender.id)
    if (entry) send(entry, { type: 'password-focus', payload })
  })
}
