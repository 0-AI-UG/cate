import * as electron from 'electron'
import { app, BrowserWindow, nativeImage, session } from 'electron'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { createBrowserIcons } from './icons'
import { allowedPageUrl, secureBrowserPage, secureBrowserSession } from './security'
import { createEngineCommands } from './commands'
import { flushPersistentSessions, installPersistentSessionTracking } from '../persistentSessions'
import { BROWSER_PAGE_CHANNELS as C } from '../../contract'
import type { BrowserSurfaceConnection, BrowserSurfaceOptions } from '../../contract/engine'

// A distinct application profile and process group; never initialize the
// desktop UI or connect a second client to the workspace runtime here.
export async function runBrowserEngine(): Promise<void> {
  app.setPath('userData', process.env.CATE_BROWSER_ENGINE_DATA!)
  // Chromium's network sandbox grants storage only below sessionData.
  // This tree is engine-owned; Cate opens only its separate UI profile.
  app.setPath('sessionData', process.env.CATE_BROWSER_SESSION_DATA!)
  app.commandLine.appendSwitch('deadline-to-synchronize-surfaces', '0')
  installPersistentSessionTracking()
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
  await app.whenReady()
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false })
  await new Promise<void>(resolve => server.once('listening', resolve))
  const port = (server.address() as { port: number }).port
  const pages = new Map<number, { window: BrowserWindow; ownerId: number; focused: boolean; visible: boolean; notify(type: string, event?: object): void; input(method: string, params: object): Promise<void>; token: string; connect(socket: WebSocket): void }>()
  const nativeIds = new Map<number, number>()
  const logicalIds = new Map<number, number>()
  const pageOwners = new Map<number, number>()
  const send = (message: unknown) => {
    if (!process.connected) return
    process.send?.(message, error => { if (error) app.exit(0) })
  }
  let nextInvocation = 0
  const invocations = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
  const callParent = (method: string, args: unknown) => new Promise<any>((resolve, reject) => {
    const invoke = ++nextInvocation
    invocations.set(invoke, { resolve, reject })
    send({ invoke, method, args })
  })
  app.on('login', (event, _page, _details, auth, callback) => {
    if (!auth.isProxy) return
    event.preventDefault()
    void callParent('proxyCredentials', { host: auth.host, port: auth.port }).then(value => callback(value?.username ?? '', value?.password ?? ''), () => callback('', ''))
  })
  const emit = (nativeId: number, channel: string, payload: unknown) => {
    const id = logicalIds.get(nativeId)
    if (id === undefined) return
    const event = payload && typeof payload === 'object' ? { ...payload as object } as Record<string, unknown> : payload
    if (event && typeof event === 'object') {
      if ('webContentsId' in event) event.webContentsId = id
      if ('openerWebContentsId' in event) event.openerWebContentsId = id
    }
    send({ event: { id, channel, payload: event } })
  }
  const commands = createEngineCommands({ page: id => pages.get(id)?.window.webContents, nativeId: id => nativeIds.get(id), pageId: id => logicalIds.get(id), ownerId: id => pageOwners.get(id), visible: id => pages.get(id)?.visible === true, focused: id => pages.get(id)?.focused === true, inputContext: (id, context) => pages.get(id)?.notify('input-context', { context }), callParent, emit })
  const icons = createBrowserIcons()
  const configured = new Map<string, Electron.Session>()
  const create = async (options: BrowserSurfaceOptions & { id: number; ownerId: number }): Promise<BrowserSurfaceConnection> => {
    if (!allowedPageUrl(options.url)) throw new Error('unsupported-browser-url')
    if (!Number.isFinite(options.width) || !Number.isFinite(options.height) || options.width < 1 || options.height < 1 || options.width > 4096 || options.height > 4096) throw new Error('invalid-browser-size')
    if (!Number.isFinite(options.scaleFactor) || options.scaleFactor < .5 || options.scaleFactor > 4) throw new Error('invalid-browser-scale')
    if (!configured.has(options.partition)) throw new Error('browser-partition-not-prepared')
    const window = new BrowserWindow({ show: false, width: options.width, height: options.height, transparent: true, backgroundColor: '#00000000',
      webPreferences: { session: configured.get(options.partition), offscreen: { deviceScaleFactor: options.scaleFactor }, backgroundThrottling: false, sandbox: true, nodeIntegration: false, contextIsolation: true, preload: process.env.CATE_BROWSER_ENGINE_PRELOAD },
    })
    const page = window.webContents
    const id = options.id
    nativeIds.set(id, page.id); logicalIds.set(page.id, id); pageOwners.set(id, options.ownerId)
    secureBrowserPage(page)
    page.setWindowOpenHandler(({ url }) => {
      if (allowedPageUrl(url)) emit(page.id, C.openTab, { openerWebContentsId: page.id, url })
      return { action: 'deny' }
    })
    page.setFrameRate(60)
    let inputEpoch = 0
    let inputQueue: Promise<unknown> = Promise.resolve()
    const input = (method: string, params: object): Promise<void> => {
      const epoch = inputEpoch
      const task = inputQueue.then(async () => {
        if (epoch !== inputEpoch || page.isDestroyed()) return
        await commands.drivers.attach(page, { panelId: options.panelId, tabId: options.tabId })
        if (epoch === inputEpoch && !page.isDestroyed()) await page.debugger.sendCommand(method, params)
      })
      inputQueue = task.catch(() => {})
      return task
    }
    const token = randomBytes(32).toString('hex')
    let socket: WebSocket | undefined
    let credit = true
    let latest: Buffer | undefined
    const sendFrame = () => {
      if (!latest || !socket || socket.readyState !== WebSocket.OPEN || !credit) return
      const frame = latest; latest = undefined; credit = false
      socket.send(frame, () => {})
    }
    page.on('paint', (_event, _dirty, image) => {
      if (pages.get(id)?.visible === false || image.isEmpty()) return
      // Keep encoding and page graphics outside Cate's renderer. Lossless PNG
      // also lets its image decoder consume a native Blob without materializing
      // a multi-megabyte JavaScript pixel array on every frame.
      const scaleFactor = Math.max(1, ...image.getScaleFactors())
      const size = image.getSize(scaleFactor)
      const pixels = image.toBitmap({ scaleFactor })
      // Presentation is always an opaque browser canvas. Capture APIs keep
      // the original transparent image; only this display copy is flattened.
      for (let i = 3; i < pixels.length; i += 4) {
        const white = 255 - pixels[i]
        if (!white) continue
        pixels[i - 3] += white; pixels[i - 2] += white; pixels[i - 1] += white; pixels[i] = 255
      }
      latest = nativeImage.createFromBitmap(pixels, size).toPNG()
      sendFrame()
    })
    let ready = false
    const state = () => ({ ready, url: page.getURL(), title: page.getTitle(), loading: page.isLoading(),
      canGoBack: page.navigationHistory.canGoBack(), canGoForward: page.navigationHistory.canGoForward() })
    const notify = (type: string, event: object = {}) => {
      if (!page.isDestroyed() && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, ...event, state: state() }), () => {})
    }
    page.on('dom-ready', () => { ready = true; notify('dom-ready') })
    page.on('did-start-navigation', (_event, _url, inPlace, main) => {
      if (!inPlace) { inputEpoch++; inputQueue = Promise.resolve(); if (main) ready = false }
    })
    page.on('did-start-loading', () => notify('did-start-loading'))
    page.on('did-stop-loading', () => notify('did-stop-loading'))
    page.on('cursor-changed', (_event, cursor) => notify('cursor', { cursor }))
    page.on('page-favicon-updated', (_event, favicons) => {
      const url = page.getURL()
      if (favicons[0]) void icons.get(options.partition, favicons[0], page.session).then(png => { if (png && !page.isDestroyed() && page.getURL() === url) notify('page-favicon-updated', { favicons: [png] }) })
    })
    page.on('page-title-updated', () => notify('page-title-updated'))
    page.on('did-navigate', (_event, url) => notify('did-navigate', { url }))
    page.on('did-navigate-in-page', (_event, url, isMainFrame) => notify('did-navigate-in-page', { url, isMainFrame }))
    page.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => notify('did-fail-load', { errorCode, errorDescription, validatedURL, isMainFrame }))
    page.on('render-process-gone', (_event, details) => notify('render-process-gone', details))
    pages.set(id, { window, ownerId: options.ownerId, focused: false, visible: true, notify, input, token, connect(next) {
      socket?.close(); socket = next; credit = true
      socket.on('message', (bytes, binary) => {
        if (binary) return
        try {
          const message = JSON.parse(bytes.toString())
          switch (message.type) {
            case 'ack': credit = true; sendFrame(); break
            case 'visible': {
              const record = pages.get(id)
              if (record) record.visible = message.value === true
              commands.updatePainting(id)
              break
            }
            case 'focus': for (const record of pages.values()) record.focused = record.window.webContents.id === page.id; break
            case 'blur': { const record = pages.get(id); if (record) record.focused = false; break }
            case 'css': void page.insertCSS(String(message.css)).catch(() => {}); break
            case 'key':
              if (message.event.type === 'keyDown') commands.drivers.noteUserInput(page.id, true)
              void input('Input.dispatchKeyEvent', message.event).catch(() => {}); break
            case 'input':
              if (message.event.type === 'mousePressed') commands.drivers.noteUserInput(page.id, true)
              void input('Input.dispatchMouseEvent', message.event).catch(() => {}); break
            case 'text':
              commands.drivers.noteUserInput(page.id, true)
              void input('Input.insertText', { text: String(message.text) }).catch(() => {}); break
            case 'composition':
              commands.drivers.noteUserInput(page.id, true)
              void input('Input.imeSetComposition', { text: String(message.text), selectionStart: message.start | 0, selectionEnd: message.end | 0 }).catch(() => {}); break
            case 'edit':
              if (['copy', 'cut', 'paste', 'pasteAndMatchStyle', 'selectAll', 'undo', 'redo', 'delete'].includes(message.action)) (page[message.action as 'copy'] as () => void).call(page)
              break
            case 'resize': window.setContentSize(Math.max(1, Math.min(4096, message.width | 0)), Math.max(1, Math.min(4096, message.height | 0))); break
            case 'navigate': if (allowedPageUrl(message.url)) void page.loadURL(message.url).catch(() => {}); break
            case 'reload': if (message.hard) page.reloadIgnoringCache(); else page.reload(); break
            case 'back': if (page.navigationHistory.canGoBack()) page.navigationHistory.goBack(); break
            case 'forward': if (page.navigationHistory.canGoForward()) page.navigationHistory.goForward(); break
            case 'zoom': page.setZoomFactor(message.factor); break
          }
        } catch { /* a closing surface may have an in-flight input */ }
      })
      notify('connected')
      sendFrame(); page.invalidate()
    } })
    window.on('closed', () => { socket?.close(); pages.delete(id) })
    commands.watch(page)
    void page.loadURL(options.url).catch(() => {})
    // A renderer is created by its first navigation. Attach after starting
    // that navigation; an unresponsive page must not prevent surface creation.
    void commands.drivers.attach(page, { panelId: options.panelId, tabId: options.tabId }).catch(() => {})
    return { id, url: `ws://127.0.0.1:${port}/${id}`, token }
  }
  server.on('connection', (socket, request) => {
    // A malformed or reset stream is a surface failure, never an uncaught
    // EventEmitter error that tears down every tab.
    socket.on('error', () => socket.close())
    const id = Number(request.url?.slice(1))
    const page = pages.get(id)
    if (!page || request.headers['sec-websocket-protocol'] !== page.token) return socket.close(1008)
    page.connect(socket)
  })
  process.on('message', async raw => {
    const response = raw as { response?: number; value?: unknown; error?: string }
    if (response.response !== undefined) {
      const waiting = invocations.get(response.response)
      invocations.delete(response.response)
      if (response.error) waiting?.reject(new Error(response.error)); else waiting?.resolve(response.value)
      return
    }
    const { request, method, args } = raw as { request: number; method: string; args: any }
    try {
      let value: unknown
      switch (method) {
        case 'shutdown':
          await flushPersistentSessions()
          app.exit(0); return
        case 'prepare':
          if (typeof args.partition !== 'string' || !/^persist:ws-[A-Za-z0-9_-]+$/.test(args.partition)) throw new Error('invalid-browser-partition')
          {
            // Own the existing workspace cookie store, in exactly one process.
            const target = session.fromPath(path.join(process.env.CATE_BROWSER_PARTITIONS!, args.partition.slice('persist:'.length).toLowerCase()))
            secureBrowserSession(target)
            await target.setProxy(args.proxy); configured.set(args.partition, target)
          }
          break
        case 'closeConnections': await configured.get(args.partition)?.closeAllConnections(); break
        case 'create': value = await create(args); break
        case 'close': pages.get(args.id)?.window.destroy(); break
        case 'key': {
          const record = pages.get(args.id)
          if (record) { if (args.event.type === 'keyDown') commands.drivers.noteUserInput(record.window.webContents.id, true); await record.input('Input.dispatchKeyEvent', args.event) }
          break
        }
        case 'edit': {
          const page = pages.get(args.id)?.window.webContents
          if (page && ['cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll', 'undo', 'redo'].includes(args.action)) (page[args.action as 'copy'] as () => void).call(page)
          break
        }
        case 'page': value = await commands.execute(args.method, args.args, args.ownerId); break
        case 'releaseOwner':
          for (const page of pages.values()) if (page.ownerId === args.ownerId) page.window.destroy()
          commands.releaseOwner(args.ownerId)
          for (const [id, owner] of pageOwners) if (owner === args.ownerId) { const native = nativeIds.get(id); if (native !== undefined) logicalIds.delete(native); nativeIds.delete(id); pageOwners.delete(id) }
          break
        case 'icon':
          if (!configured.has(args.partition)) throw new Error('browser-partition-not-prepared')
          value = await icons.get(args.partition, args.url, configured.get(args.partition)!); break
        case 'nativeTest':
          if (process.env.CATE_E2E !== '1') throw new Error('test-only')
          value = await new Function('electron', 'args', `return (${args.fn})(electron, args)`)(
            { ...electron, webContents: { ...electron.webContents,
              fromId: (id: number) => pages.get(id)?.window.webContents,
              getAllWebContents: () => [...pages.values()].map(page => page.window.webContents),
            } }, args.args)
          break
        case 'inspect':
          if (process.env.CATE_E2E !== '1') throw new Error('test-only')
          value = { pid: process.pid, metrics: app.getAppMetrics() }; break
        case 'crash':
          if (process.env.CATE_E2E !== '1') throw new Error('test-only')
          setImmediate(() => { throw new Error('intentional-browser-engine-test-failure') }); break
        case 'evaluate':
          if (process.env.CATE_E2E !== '1') throw new Error('test-only')
          value = await pages.get(args.id)!.window.webContents.executeJavaScript(args.script); break
        default: throw new Error('unknown-browser-engine-method')
      }
      send({ request, value })
    } catch (error) { send({ request, error: error instanceof Error ? error.message : String(error) }) }
  })
  process.once('disconnect', () => app.exit(0))
  app.on('window-all-closed', () => {})
  send({ ready: true })
}
