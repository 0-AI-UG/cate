import { app, BrowserWindow, ipcMain } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { BROWSER_METHODS, type BrowserCodeResult, type BrowserContent, type BrowserImage } from '../../shared/browserAutomation'

const BROWSER_CODE_DATA_LIMIT = 16_000_000

// Authorization needs a fingerprint, not another retained copy of PNG data.
const imageFingerprint = (image: BrowserImage): string => createHash('sha256')
  .update(JSON.stringify([image.mimeType, image.width, image.height])).update(image.data).digest('hex')

export type BrowserCodeInvoke = (method: string, args: Record<string, unknown>) => Promise<unknown>

// Installed in the disposable sandbox renderer. Keep this self-contained: no
// imports, Node globals or main-process objects cross this boundary.
export function installBrowserCodeSdk(): void {
  const root = globalThis as unknown as Record<string, any>
  const bridge = root.__cateBrowserBridge
  let cell = ''
  const rpc = async (method: string, args: Record<string, unknown> = {}): Promise<any> => {
    const response = JSON.parse(await bridge.invoke(JSON.stringify({ cell, method, args })))
    if (response.error) throw new Error(typeof response.error === 'string' ? response.error : JSON.stringify(response.error))
    return response.value
  }
  const emit = async (result: any, enabled = true): Promise<any> => {
    const observation = result?.observation ?? (result?.observationId ? result : undefined)
    if (enabled && observation) await rpc('__observation', { observationId: observation.observationId })
    return result
  }
  const bind = async (method: string, args: Record<string, unknown>): Promise<any> => {
    const result = await rpc(method, args)
    const observation = result?.observation ?? result
    if (!observation?.panelId || !observation?.tabId) throw new Error('Browser binding did not resolve a panel and tab')
    const binding = { panelId: observation.panelId, tabId: observation.tabId }
    const initial = observation.observationId ? observation : await rpc(args.screenshot === true ? 'getAXStateAndScreenshot' : 'getAXState', binding)
    let observationId = initial.observationId
    let axObservationId = initial.kind === 'image' ? undefined : initial.observationId
    let documentId = initial.documentId
    let imageOnly = initial.kind === 'image'
    await emit(initial)
    const call = async (name: string, params: Record<string, unknown> = {}, enabled = true): Promise<any> => {
      // Focus can change without navigation. Image-only reads must not make an
      // old focused AX node look fresh, especially in child frames/shadow roots.
      if (name === 'typeText' && imageOnly) await call('getAXState', {}, false)
      const numericTarget = typeof params.target === 'number'
        || (name === 'waitFor' && typeof (params.condition as any)?.element === 'number')
      if (numericTarget && !axObservationId) throw new Error('Get a fresh AX observation before using numeric element IDs')
      const useAX = numericTarget || name === 'typeText'
        || name === 'getAXState' || name === 'getAXStateAndScreenshot' || name === 'getScreenshot'
      const next = await rpc(name, { ...params, ...binding, observationId: useAX ? axObservationId ?? observationId : observationId })
      const state = next?.observation ?? next
      if (state?.observationId) {
        if (state.documentId !== documentId) axObservationId = undefined
        documentId = state.documentId
        observationId = state.observationId
        imageOnly = state.kind === 'image'
        if (!imageOnly) axObservationId = state.observationId
      }
      return emit(next, enabled)
    }
    return Object.freeze({
      ...binding,
      getAXState: (options: any = {}) => call('getAXState', options, options.emit !== false),
      getScreenshot: (options: any = {}) => call('getScreenshot', options, options.emit !== false),
      getAXStateAndScreenshot: (options: any = {}) => call('getAXStateAndScreenshot', options, options.emit !== false),
      click: (target: unknown, options: Record<string, unknown> = {}) => call('click', { ...options, target }),
      setValue: (target: unknown, value: unknown) => call('setValue', { target, value }),
      typeText: (text: string) => call('typeText', { text }),
      pressKey: (key: string) => call('pressKey', { key }),
      scroll: (target: unknown, direction: string, pages = 1) => call('scroll', { target, direction, pages }),
      drag: (from: unknown, to: unknown) => call('drag', { from, to }),
      selectText: (target: unknown, text: string, options: Record<string, unknown> = {}) => call('selectText', { ...options, target, text }),
      setChecked: (target: unknown, checked: boolean) => call('setChecked', { target, checked }),
      selectOption: (target: unknown, values: unknown) => call('selectOption', { target, values }),
      upload: (target: unknown, filePath: string) => call('upload', { target, filePath }),
      waitFor: (condition: unknown, options: Record<string, unknown> = {}) => call('waitFor', { ...options, condition }),
      goto: (url: string) => call('goto', { url }),
      back: () => call('back'), forward: () => call('forward'), reload: () => call('reload'), close: () => call('close'),
      setViewport: (size: Record<string, unknown>) => call('setViewport', size),
      resize: (size: Record<string, unknown>) => call('resize', size),
      downloads: () => call('downloads'),
    })
  }
  Object.defineProperties(root, {
    __cateBeginCell: { value: (id: string) => { cell = id } },
    cua: { value: Object.freeze({
      listTabs: async () => { const result = await rpc('listTabs'); await rpc('__write', { value: result }); return result },
      getTab: (binding: Record<string, unknown>) => bind('getTab', binding),
      createBrowserTab: (url: string, options: Record<string, unknown> = {}) => bind('createTab', { ...options, url }),
    }) },
    nodeRepl: { value: Object.freeze({
      write: (value: unknown) => rpc('__write', { value }),
      emitImage: (image: unknown) => rpc('__image', { image }),
    }) },
  })
  // No asynchronous scheduling outside an awaited browser call. A cell cannot
  // leave a timer behind that gains authority from the next cell.
  for (const name of ['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback', 'queueMicrotask']) {
    Object.defineProperty(root, name, { value: undefined, configurable: false, writable: false })
  }
}

interface Cell {
  id: string
  invoke: BrowserCodeInvoke
  content: BrowserContent[]
  observations: Map<string, any>
  images: Set<string>
  calls: number
  bytes: number
  pending: number
  retainedBytes: number
}
interface CodeSession { window: BrowserWindow; cell?: Cell }

export class BrowserCodeSessions {
  private sessions = new Map<string, CodeSession>()
  private queues = new Map<string, Promise<unknown>>()
  private registered = false
  private generations = new Map<string, number>()

  constructor(private readonly deadlineMs = 30_000) {}

  run(key: string, code: string, invoke: BrowserCodeInvoke): Promise<BrowserCodeResult> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const generation = this.generations.get(key) ?? 0
    const next = previous.catch(() => {}).then(() => {
      if ((this.generations.get(key) ?? 0) !== generation) return { content: [{ type: 'text' as const, text: 'Browser code session was reset; queued cell cancelled' }], isError: true }
      return this.execute(key, code, invoke)
    })
    this.queues.set(key, next)
    void next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key) }).catch(() => {})
    return next
  }

  reset(key: string): void {
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1)
    const session = this.sessions.get(key)
    if (!session) return
    session.cell = undefined
    this.sessions.delete(key)
    if (!session.window.isDestroyed()) session.window.destroy()
  }

  dispose(prefix?: string): void {
    for (const key of new Set([...this.sessions.keys(), ...this.queues.keys()])) if (prefix === undefined || key.startsWith(prefix)) this.reset(key)
  }

  private register(): void {
    if (this.registered) return
    this.registered = true
    ipcMain.handle('cate:browser-code', async (event, raw: unknown) => {
      const session = [...this.sessions.values()].find(entry => entry.window.webContents === event.sender)
      if (!session || event.senderFrame !== event.sender.mainFrame) throw new Error('Unregistered browser-code sender')
      try { return JSON.stringify({ value: await this.dispatch(session, raw) }) }
      catch (error) { return JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }
    })
  }

  private append(cell: Cell, content: BrowserContent): void {
    const bytes = content.type === 'text' ? content.text.length : content.data.length
    if (cell.bytes + bytes > BROWSER_CODE_DATA_LIMIT || cell.content.length >= 200) throw new Error('Browser code output limit exceeded')
    cell.bytes += bytes
    cell.content.push(content)
  }

  private async dispatch(session: CodeSession, raw: unknown): Promise<unknown> {
    if (typeof raw !== 'string' || raw.length > BROWSER_CODE_DATA_LIMIT) throw new Error('Invalid browser-code request')
    const request = JSON.parse(raw)
    const cell = session.cell
    if (!cell || request.cell !== cell.id) throw new Error('Browser code cell is no longer active')
    const { method, args } = request
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid browser-code arguments')
    if (method === '__write') {
      this.append(cell, { type: 'text', text: typeof args.value === 'string' ? args.value : JSON.stringify(args.value) ?? 'undefined' })
      return null
    }
    if (method === '__image') {
      const image = args.image as BrowserImage
      if (!image || typeof image.data !== 'string' || !cell.images.has(imageFingerprint(image))) throw new Error('Only browser observation images can be emitted')
      this.append(cell, { type: 'image', mimeType: 'image/png', data: image.data })
      return null
    }
    if (method === '__observation') {
      const recorded = cell.observations.get(args.observationId)
      if (!recorded) throw new Error('Unknown browser observation')
      const { screenshot, elements: _elements, ...state } = recorded.observation
      this.append(cell, { type: 'text', text: JSON.stringify({ ...(recorded.action ? { action: recorded.action } : {}), ...state }) })
      if (screenshot) this.append(cell, { type: 'image', mimeType: 'image/png', data: screenshot.data })
      return null
    }
    if (typeof method !== 'string' || !BROWSER_METHODS.has(method)) throw new Error('Unsupported browser method')
    if (++cell.calls > 100) throw new Error('Browser code action limit exceeded')
    cell.pending++
    try {
      const result = await cell.invoke(`cate.browser.${method}`, args)
      if (session.cell !== cell) throw new Error('Browser code cell is no longer active')
      if (result && typeof result === 'object' && 'error' in result) throw new Error([String(result.error), 'recovery' in result ? String(result.recovery) : ''].filter(Boolean).join(' — '))
      const value = result as any
      const observation = value?.observation ?? (value?.observationId ? value : undefined)
      if (observation) {
        // Independently bound retained RPC data, including emit:false. Output has
        // its own limit; emitted PNG strings share the observation's data and
        // are not charged a second time to this retained-data budget.
        const bytes = JSON.stringify({ observation, action: value?.action }).length
        const previousBytes = cell.observations.get(observation.observationId)?.bytes ?? 0
        const retainedBytes = cell.retainedBytes - previousBytes + bytes
        if (retainedBytes > BROWSER_CODE_DATA_LIMIT) throw new Error('Browser code retained observation limit exceeded')
        cell.retainedBytes = retainedBytes
        cell.observations.set(observation.observationId, { observation, action: value?.action, bytes })
        if (observation.screenshot) cell.images.add(imageFingerprint(observation.screenshot))
      }
      return result
    } finally { cell.pending-- }
  }

  private async create(key: string): Promise<CodeSession> {
    this.register()
    const window = new BrowserWindow({
      show: false, width: 1, height: 1,
      webPreferences: { preload: path.join(app.getAppPath(), 'dist/preload/browserAgent.js'), sandbox: true,
        nodeIntegration: false, contextIsolation: true, webSecurity: true,
        partition: `cate-browser-code-${randomUUID()}` },
    })
    const session: CodeSession = { window }
    this.sessions.set(key, session)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    window.webContents.session.setPermissionCheckHandler(() => false)
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('data:text/html,') }))
    await window.loadURL('data:text/html,' + encodeURIComponent('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; connect-src \'none\'; frame-src \'none\'; worker-src \'none\'; form-action \'none\'">'))
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Runtime.evaluate', { expression: `(${installBrowserCodeSdk.toString()})()`, awaitPromise: true })
    return session
  }

  private async execute(key: string, code: string, invoke: BrowserCodeInvoke): Promise<BrowserCodeResult> {
    if (typeof code !== 'string' || code.length > 100_000) return { content: [{ type: 'text', text: 'Browser code must be at most 100000 characters' }], isError: true }
    let timer: ReturnType<typeof setTimeout> | undefined
    let session: CodeSession | undefined
    let activeCell: Cell | undefined
    try {
      const execute = async (): Promise<BrowserCodeResult> => {
        session = this.sessions.get(key) ?? await this.create(key)
        const cell: Cell = { id: randomUUID(), invoke, content: [], observations: new Map(), images: new Set(), calls: 0, bytes: 0, pending: 0, retainedBytes: 0 }
        activeCell = cell
        session.cell = cell
        await session.window.webContents.debugger.sendCommand('Runtime.evaluate', { expression: `__cateBeginCell(${JSON.stringify(cell.id)})` })
        const result = await session.window.webContents.debugger.sendCommand('Runtime.evaluate', { expression: code, replMode: true, awaitPromise: true, returnByValue: false, objectGroup: cell.id })
        if (cell.pending) throw new Error('Await every browser call; unawaited work reset this session')
        session.cell = undefined
        if (result.exceptionDetails) {
          const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Browser code failed'
          this.append(cell, { type: 'text', text })
          return { content: cell.content, isError: true }
        }
        return { content: cell.content }
      }
      return await Promise.race([execute(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { this.reset(key); reject(new Error('Browser code timed out; session reset')) }, this.deadlineMs)
      })])
    } catch (error) {
      const content = activeCell?.content ?? []
      this.reset(key)
      return { content: [...content, { type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
    } finally {
      if (timer) clearTimeout(timer)
      if (activeCell && session && !session.window.isDestroyed()) {
        // Release protocol handles only; persistent JavaScript bindings remain.
        await session.window.webContents.debugger.sendCommand('Runtime.releaseObjectGroup', { objectGroup: activeCell.id }).catch(() => {})
      }
    }
  }
}

export const browserCodeSessions = new BrowserCodeSessions()
