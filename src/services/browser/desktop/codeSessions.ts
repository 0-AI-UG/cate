// Browser code cells (`cate.browser.run`) on this client. Each caller key gets
// a disposable sandboxed renderer with no Node, network or DOM access; agent
// JavaScript runs there through CDP and reaches pages only through `cua.*`
// calls, which `invoke` sends back to the runtime (`browserCode.call`) so they
// go through the same session and gates as any other `cate.browser.*` call.

import { BrowserWindow, ipcMain } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { CodeCellRegistry } from './codeCells'
import { BROWSER_METHODS, describeBrowserObservation, type BrowserCodeResult, type BrowserContent, type BrowserImage } from '../contract'

const BROWSER_CODE_DATA_LIMIT = 16_000_000
/** Reset keys remembered for the next cell's hint; the oldest are forgotten. */
const LOST_KEYS_LIMIT = 256

// Authorization needs a fingerprint, not another retained copy of PNG data.
const imageFingerprint = (image: BrowserImage): string => createHash('sha256')
  .update(JSON.stringify([image.mimeType, image.width, image.height])).update(image.data).digest('hex')

type BrowserCodeInvoke = (method: string, args: Record<string, unknown>) => Promise<unknown>

// Installed in the disposable sandbox renderer. Keep this self-contained: no
// imports, Node globals or main-process objects cross this boundary.
function installBrowserCodeSdk(): void {
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
  // A tab of the cell's browser panel (the command line chose it; code never
  // names panels). `resolve` binds it on its first call and the
  // binding stays pinned for the cell: a user's tab switch fails the calls
  // after it instead of moving them to another tab. Without an observation
  // yet, a call acts on the driver's latest one (as a CLI command does).
  const tabOf = (resolve: () => Promise<any>): any => {
    let binding: { tabId: string } | undefined
    let observationId: string | undefined
    let axObservationId: string | undefined
    let documentId: string | undefined
    let imageOnly = false
    const track = (result: any): void => {
      const state = result?.observation ?? result
      if (!state?.observationId) return
      if (documentId !== undefined && state.documentId !== documentId) axObservationId = undefined
      documentId = state.documentId
      observationId = state.observationId
      imageOnly = state.kind === 'image'
      if (!imageOnly) axObservationId = state.observationId
    }
    const bound = async (): Promise<{ tabId: string }> => {
      if (binding) return binding
      const page = await resolve()
      const state = page?.observation ?? page
      if (!state?.tabId) throw new Error('Browser binding did not resolve a tab')
      binding = { tabId: state.tabId }
      track(state)
      return binding
    }
    const call = async (name: string, params: Record<string, unknown> = {}, enabled = true): Promise<any> => {
      const target = await bound()
      // Focus can change without navigation. Image-only reads must not make an
      // old focused AX node look fresh, especially in child frames/shadow roots.
      if (name === 'typeText' && imageOnly) await call('getAXState', {}, false)
      const numericTarget = typeof params.target === 'number'
        || (name === 'waitFor' && typeof (params.condition as any)?.element === 'number')
      const useAX = numericTarget || name === 'typeText'
        || name === 'getAXState' || name === 'getAXStateAndScreenshot' || name === 'getScreenshot'
      const baseline = useAX ? axObservationId ?? observationId : observationId
      const next = await rpc(name, { ...params, ...target, ...(baseline ? { observationId: baseline } : {}) })
      track(next)
      return emit(next, enabled)
    }
    // Every method takes a trailing options object; `{emit:false}` keeps its
    // observation out of the cell's output.
    const with_ = (name: string, params: Record<string, unknown>, { emit, ...options }: any = {}) =>
      call(name, { ...options, ...params }, emit !== false)
    return Object.freeze({
      get tabId() { return binding?.tabId },
      getAXState: (options: any = {}) => with_('getAXState', {}, options),
      getScreenshot: (options: any = {}) => with_('getScreenshot', {}, options),
      getAXStateAndScreenshot: (options: any = {}) => with_('getAXStateAndScreenshot', {}, options),
      getAttribute: (target: unknown, name: string) => call('getAttribute', { target, name }),
      click: (target: unknown, options: any = {}) => with_('click', { target }, options),
      setValue: (target: unknown, value: unknown, options: any = {}) => with_('setValue', { target, value }, options),
      typeText: (text: string, options: any = {}) => with_('typeText', { text }, options),
      pressKey: (key: string, options: any = {}) => with_('pressKey', { key }, options),
      scroll: (target: unknown, direction: string, pages = 1, options: any = {}) => with_('scroll', { target, direction, pages }, options),
      drag: (from: unknown, to: unknown, options: any = {}) => with_('drag', { from, to }, options),
      selectText: (target: unknown, text: string, options: any = {}) => with_('selectText', { target, text }, options),
      setChecked: (target: unknown, checked: boolean, options: any = {}) => with_('setChecked', { target, checked }, options),
      selectOption: (target: unknown, values: unknown, options: any = {}) => with_('selectOption', { target, values }, options),
      upload: (target: unknown, filePath: string, options: any = {}) => with_('upload', { target, filePath }, options),
      waitFor: (condition: unknown, options: any = {}) => with_('waitFor', { condition }, options),
      goto: (url: string, options: any = {}) => with_('goto', { url }, options),
      back: (options: any = {}) => with_('back', {}, options),
      forward: (options: any = {}) => with_('forward', {}, options),
      reload: (options: any = {}) => with_('reload', {}, options),
      close: () => call('close'),
      setViewport: (size: Record<string, unknown>) => call('setViewport', size),
      resize: (size: Record<string, unknown>) => call('resize', size),
      download: (url?: string) => call('download', url === undefined ? {} : { url }),
      downloads: () => call('downloads'),
    })
  }
  // `cua.getTab` and `cua.createBrowserTab` make the tab they bind the cell's
  // `tab`, and show its page.
  const bind = async (method: string, args: Record<string, unknown>, options: any = {}): Promise<any> => {
    const result = await rpc(method, args)
    const tab = tabOf(async () => result)
    root.tab = tab
    const page = result?.observation ?? result
    await emit(page?.observationId ? page : await tab.getAXState({ emit: false }), options?.emit !== false)
    return tab
  }
  Object.defineProperties(root, {
    // Each cell starts with `tab`: the active tab of the cell's browser panel.
    __cateBeginCell: { value: (id: string) => {
      cell = id
      root.tab = tabOf(() => rpc('getTab'))
    } },
    cua: { value: Object.freeze({
      listTabs: async () => { const result = await rpc('listTabs'); await rpc('__write', { value: result }); return result },
      getTab: (binding: Record<string, unknown> = {}, options: any = {}) => bind('getTab', binding, options),
      createBrowserTab: (url: string, { emit, ...options }: any = {}) => bind('createTab', { ...options, url }, { emit }),
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

export interface BrowserCodeSessionsOptions {
  /** The built `preload/codeCell.ts`. */
  preloadPath?: string
  cells?: CodeCellRegistry
  deadlineMs?: number
}

export interface RunCodeOptions {
  /** The runtime's id for the cell, so its calls can be authorized there. */
  cellId?: string
  deadlineMs?: number
}

export class BrowserCodeSessions {
  private sessions = new Map<string, CodeSession>()
  private queues = new Map<string, Promise<unknown>>()
  private registered = false
  private generations = new Map<string, number>()
  /** Keys whose session was reset since their last cell: bindings are gone. */
  private lost = new Set<string>()
  readonly cells: CodeCellRegistry
  private readonly deadlineMs: number

  constructor(private readonly options: BrowserCodeSessionsOptions = {}) {
    this.cells = options.cells ?? new CodeCellRegistry()
    this.deadlineMs = options.deadlineMs ?? 30_000
  }

  run(key: string, code: string, invoke: BrowserCodeInvoke, options: RunCodeOptions = {}): Promise<BrowserCodeResult> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const generation = this.generations.get(key) ?? 0
    const next = previous.catch(() => {}).then(() => {
      if ((this.generations.get(key) ?? 0) !== generation) return { content: [{ type: 'text' as const, text: 'Browser code session was reset; queued cell cancelled' }], isError: true }
      return this.execute(key, code, invoke, options)
    })
    this.queues.set(key, next)
    void next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key) }).catch(() => {})
    return next
  }

  reset(key: string): void {
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1)
    const session = this.sessions.get(key)
    if (!session) return
    if (session.cell) this.cells.end(session.cell.id)
    session.cell = undefined
    this.sessions.delete(key)
    this.lost.delete(key)
    this.lost.add(key)
    if (this.lost.size > LOST_KEYS_LIMIT) this.lost.delete(this.lost.values().next().value!)
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
      const { screenshot } = recorded.observation
      this.append(cell, { type: 'text', text: describeBrowserObservation(recorded.observation, recorded.action) })
      if (screenshot) this.append(cell, { type: 'image', mimeType: 'image/png', data: screenshot.data })
      return null
    }
    if (typeof method !== 'string' || !BROWSER_METHODS.has(method)) throw new Error('Unsupported browser method')
    if (++cell.calls > 100) throw new Error('Browser code action limit exceeded')
    cell.pending++
    try {
      const result = await cell.invoke(`cate.browser.${method}`, { ...args, _codeCellId: cell.id })
      if (session.cell !== cell) throw new Error('Browser code cell is no longer active')
      if (result && typeof result === 'object' && 'error' in result) throw new Error([String(result.error), 'recovery' in result ? String(result.recovery) : ''].filter(Boolean).join(': '))
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
      webPreferences: { preload: this.options.preloadPath, sandbox: true,
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

  private async execute(key: string, code: string, invoke: BrowserCodeInvoke, options: RunCodeOptions): Promise<BrowserCodeResult> {
    if (typeof code !== 'string' || code.length > 100_000) return { content: [{ type: 'text', text: 'Browser code must be at most 100000 characters' }], isError: true }
    const deadlineMs = Math.min(options.deadlineMs ?? this.deadlineMs, this.deadlineMs)
    const lost = this.lost.delete(key)
    const deadline = Date.now() + deadlineMs
    let timer: ReturnType<typeof setTimeout> | undefined
    let session: CodeSession | undefined
    let activeCell: Cell | undefined
    try {
      const execute = async (): Promise<BrowserCodeResult> => {
        session = this.sessions.get(key) ?? await this.create(key)
        const cell: Cell = { id: options.cellId ?? randomUUID(), invoke, content: [], observations: new Map(), images: new Set(), calls: 0, bytes: 0, pending: 0, retainedBytes: 0 }
        activeCell = cell
        this.cells.begin(cell.id, deadline)
        session.cell = cell
        await session.window.webContents.debugger.sendCommand('Runtime.evaluate', { expression: `__cateBeginCell(${JSON.stringify(cell.id)})` })
        const result = await session.window.webContents.debugger.sendCommand('Runtime.evaluate', { expression: code, replMode: true, awaitPromise: true, returnByValue: false, objectGroup: cell.id })
        if (cell.pending) throw new Error('Await every browser call; unawaited work reset this session')
        session.cell = undefined
        if (result.exceptionDetails) {
          const description: string = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Browser code failed'
          // Stack frames point into the SDK and the REPL, never at the agent's code.
          let text = description.split('\n').filter(line => !/^\s+at /.test(line)).join('\n')
          if (lost && /^ReferenceError/.test(text)) {
            text += '\nThe previous browser code session was reset (a timeout, an error or `cate browser reset`), so variables from earlier cells are gone. Every cell still starts with `tab`.'
          }
          this.append(cell, { type: 'text', text })
          return { content: cell.content, isError: true }
        }
        return { content: cell.content }
      }
      return await Promise.race([execute(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          this.reset(key)
          reject(new Error(`Browser code timed out after ${Math.round(deadlineMs / 1000)}s and the session was reset: variables from earlier cells are gone. The next cell starts with \`tab\` again.`))
        }, deadlineMs)
      })])
    } catch (error) {
      const content = activeCell?.content ?? []
      this.reset(key)
      return { content: [...content, { type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
    } finally {
      if (timer) clearTimeout(timer)
      if (activeCell) this.cells.end(activeCell.id)
      if (activeCell && session && !session.window.isDestroyed()) {
        // Release protocol handles only; persistent JavaScript bindings remain.
        await session.window.webContents.debugger.sendCommand('Runtime.releaseObjectGroup', { objectGroup: activeCell.id }).catch(() => {})
      }
    }
  }
}

