// Page services run beside the engine's webContents, not in Cate's UI process.
import { EventEmitter } from 'node:events'
import { GuestDownloads } from '../downloads'
import { ipcMain, type WebContents } from 'electron'
import { BROWSER_GUEST_CHANNELS, BROWSER_PAGE_CHANNELS as C, type BrowserGuestRef } from '../../contract'
import { GuestDialogs, registerGuestDialogs } from '../dialogs'
import { PageDriverRegistry } from '../pageDriver'
import { createPageLifecycle } from '../pageLifecycle'
import { flattenScreenshotPng } from '../screenshotPng'

export function createEngineCommands(deps: {
  page(id: number): WebContents | undefined
  nativeId(id: number): number | undefined
  pageId(nativeId: number): number | undefined
  ownerId(id: number): number | undefined
  visible(id: number): boolean
  focused(id: number): boolean
  inputContext(id: number, value: unknown): void
  callParent(method: string, args: unknown): Promise<any>
  emit(id: number, channel: string, payload: unknown): void
}) {
  const nativePage = (id: number) => { const pageId = deps.pageId(id); return pageId === undefined ? undefined : deps.page(pageId) }
  const dialogs = new GuestDialogs(event => deps.emit(event.webContentsId, C.dialog, event))
  const drivers = new PageDriverRegistry({ dialogs, notifyInputContext: (id, context) => deps.inputContext(deps.pageId(id)!, context), chooseFiles: (webContentsId, options) => deps.focused(deps.pageId(webContentsId)!) ? deps.callParent('chooseFiles', { webContentsId: deps.pageId(webContentsId), ...options }) : Promise.resolve(null), notifyPassword: (webContentsId, channel, payload) => deps.emit(webContentsId, C.password, { webContentsId, channel, payload }) })
  const owners = new Map<number, EventEmitter & { id: number; send(channel: string, payload: unknown): void }>()
  const downloads = new GuestDownloads({
    downloadDir: () => process.env.CATE_BROWSER_DOWNLOAD_DIR!,
    owner(page) {
      const id = deps.ownerId(deps.pageId(page.id)!)
      if (id === undefined) return undefined
      let owner = owners.get(id)
      if (!owner) { owner = Object.assign(new EventEmitter(), { id, send() {} }); owners.set(id, owner) }
      return owner
    },
    notify: (_owner, event) => deps.emit(event.webContentsId, C.downloads, event),
  })
  const lifecycle = createPageLifecycle({ busy: id => !!dialogs.current(id) || downloads.list(id).some(d => d.state === 'progressing' || d.state === 'paused') })
  const activeOperations = new WeakMap<WebContents, number>()
  const updatePainting = (id: number, page = deps.page(id)) => {
    if (!page || page.isDestroyed()) return
    const needed = deps.visible(id) || activeOperations.has(page)
    if (needed && !page.isPainting()) page.startPainting()
    if (!needed && page.isPainting()) page.stopPainting()
  }
  registerGuestDialogs(dialogs, id => !!nativePage(id))
  const mainFrame = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => !!nativePage(event.sender.id) && event.senderFrame === event.sender.mainFrame
  ipcMain.on('cate-passkeys-available', event => { event.returnValue = process.env.CATE_BROWSER_PASSKEYS === '1' && mainFrame(event) })
  ipcMain.on('cate-passkeys-cancel', (event, id: unknown) => {
    if (mainFrame(event) && typeof id === 'string') void deps.callParent('cancelPasskey', { webContentsId: deps.pageId(event.sender.id), id }).catch(() => {})
  })
  ipcMain.handle('cate-passkeys-request', async (event, input: unknown) => {
    const page = event.sender
    const frame = event.senderFrame
    if (!mainFrame(event) || !drivers.isRegistered(page.id) || !deps.focused(deps.pageId(page.id)!) || !frame) return { error: 'NotAllowedError' }
    const origin = new URL(frame.url).origin
    const id = input && typeof input === 'object' ? (input as { id?: string }).id : undefined
    const cancel = () => { if (id) void deps.callParent('cancelPasskey', { webContentsId: deps.pageId(page.id), id }).catch(() => {}) }
    const navigate = (_event: unknown, _url: string, _inPlace: boolean, main: boolean) => { if (main) cancel() }
    page.on('did-start-navigation', navigate); page.once('destroyed', cancel)
    try {
      const result = await deps.callParent('passkey', { webContentsId: deps.pageId(page.id), origin, input })
      return page.isDestroyed() || frame.isDestroyed() || new URL(frame.url).origin !== origin ? { error: 'AbortError' } : result
    } catch { return { error: 'NotAllowedError' } } finally {
      page.removeListener('did-start-navigation', navigate); page.removeListener('destroyed', cancel)
    }
  })
  ipcMain.on(BROWSER_GUEST_CHANNELS.userInput, event => { if (nativePage(event.sender.id)) drivers.noteUserInput(event.sender.id) })
  ipcMain.on(BROWSER_GUEST_CHANNELS.dirty, event => { if (nativePage(event.sender.id)) lifecycle.noteInput(event.sender) })
  return {
    drivers,
    updatePainting,
    watch(page: WebContents) { lifecycle.watch(page); downloads.watch(page.session) },
    releaseOwner(id: number) { owners.get(id)?.emit('destroyed'); owners.delete(id) },
    async execute(method: string, args: any[], ownerId: number): Promise<unknown> {
      const ref: BrowserGuestRef | number = args[0]
      const id = typeof ref === 'number' ? ref : ref.webContentsId
      if (method === 'downloadAction') return downloads.act(ownerId, deps.nativeId(id)!, args[1], args[2])
      if (method === 'readDownload') return downloads.read(ownerId, deps.nativeId(id)!, args[1])
      const page = deps.page(id)
      if (!page || page.isDestroyed()) throw new Error('no-guest')
      activeOperations.set(page, (activeOperations.get(page) ?? 0) + 1)
      try {
        updatePainting(id, page)
        switch (method) {
          case 'attach':
            lifecycle.watch(page)
            await drivers.attach(page, ref as BrowserGuestRef)
            return
          case 'execute':
            lifecycle.protect(page)
            return await drivers.execute(page.id, ref as BrowserGuestRef, args[1], args[2] ?? {})
          case 'protectPage': lifecycle.protect(page); return
          case 'preparePageDiscard': return await lifecycle.prepareDiscard(page)
          case 'restartIfHung': return await drivers.restartIfHung(page.id)
          case 'fillCredential': return await drivers.fillCredential(page.id, args[1], args[2], args[3])
          case 'answerDialog': dialogs.answer(page.id, args[2], args[1]); return
          case 'screenshot': {
            const image = await page.capturePage()
            if (image.isEmpty()) return null
            return { dataUrl: `data:image/png;base64,${flattenScreenshotPng(image.toPNG()).toString('base64')}` }
          }
          case 'download': {
            const url = args[1]
            if (typeof url !== 'string' || !['http:', 'https:', 'data:', 'blob:'].includes(new URL(url).protocol)) throw new Error('unsupported-download-url')
            page.downloadURL(url); return
          }
          default: throw new Error('unsupported-browser-command')
        }
      } finally {
        const remaining = activeOperations.get(page)! - 1
        if (remaining) activeOperations.set(page, remaining)
        else activeOperations.delete(page)
        updatePainting(id, page)
      }
    },
  }
}
