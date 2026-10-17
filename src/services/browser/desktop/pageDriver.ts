// The page driver (architecture 10.2): Cate's CDP engine over one webview's
// webContents in desktop main. Accessibility snapshots, actions, screenshots
// and waits for exactly one guest, bound to one logical panel tab. The
// renderer routes the runtime's surface requests here through the desktop
// IPC (`./ipc.ts`); there is no global target lookup.

import { clipboard, type WebContents } from 'electron'
import {
  BROWSER_ACTION_METHODS,
  BROWSER_ELEMENT_READ_METHODS,
  BROWSER_LOG_METHODS,
  BROWSER_OBSERVATION_METHODS,
  BROWSER_WAIT_MAX_MS,
  browserDialogNotice,
  browserLocatorOf,
  describeBrowserElement,
  describeBrowserLocator,
  matchBrowserElements,
  browserRecovery,
  diffBrowserState,
  type BrowserActionOutcome,
  type BrowserDriverResult,
  type BrowserElement,
  type BrowserImage,
  type BrowserLocator,
  type BrowserObservation,
  type BrowserObservationPerformance,
  type BrowserPageIdentity,
  type BrowserViewportState,
} from '../contract'
import { BrowserObservationCache, type CachedBrowserObservation } from './observationCache'
import { readBrowserAX } from './ax'
import { parseKey } from './keys'
import { PageLog } from './pageLog'
import { FrameTree } from './frames'
import { FILE_INPUT_OF, PASSWORD_FIELD, USERNAME_FIELD, USERNAME_FOR_PASSWORD } from './pageScripts'
import type { GuestDialogs } from './dialogs'

type BrowserArgs = Record<string, unknown>

export type { BrowserPageIdentity }

export interface PageDriverOptions {
  /** The guests' JavaScript dialogs: a call a dialog interrupts returns it,
   *  and `dialog` answers it. */
  dialogs?: Pick<GuestDialogs, 'current' | 'subscribe' | 'answer'>
}

type CursorKind = NonNullable<BrowserDriverResult['cursor']>['kind']

interface ElementTarget {
  objectId?: string
  backendNodeId: number
  frameId?: string
  sessionId?: string
}

interface RefTarget {
  backendNodeId: number
  documentEpoch: number
  frameId?: string
  sessionId?: string
}

/** An observation's screenshot, or why it has none. */
interface Pixels { image?: BrowserImage; screenshotError?: string }

interface CdpEvent {
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

/** Guests receiving a driver's key events right now. */
const sendingKeys = new WeakSet<WebContents>()
/** True while `contents` receives an agent's key event: the page's key,
 *  never an app shortcut. */
export function isAgentKeyInput(contents: WebContents): boolean {
  return sendingKeys.has(contents)
}

/** How long one CDP command may take before the page counts as hung. */
const CDP_TIMEOUT_MS = 10_000
const PAGE_UNRESPONSIVE = 'browser-page-unresponsive'
/** How long a hung page's renderer may take to go away when killed. */
const RESTART_TIMEOUT_MS = 5_000
/** How long an action waits for its element to become actionable. */
const ACTIONABLE_TIMEOUT_MS = 5_000
/** How often a locator looks for its element in a fresh snapshot. */
const LOCATOR_POLL_MS = 250
/** The most matches an ambiguous locator lists. */
const LOCATOR_LISTED = 10
/** Where a covered element is scrolled to on each retry. */
const OBSCURED_SCROLL_ALIGNMENTS = ['center', 'start', 'end'] as const
/** Errors an element can grow out of while the page settles. */
const TRANSIENT_ELEMENT_ERRORS = ['element-not-stable', 'element-obscured', 'element-not-visible', 'element-disabled', 'element-has-no-actionable-box']
/** Requests an action may have started that its result should wait for. */
const SETTLE_REQUEST_TYPES = new Set(['Document', 'XHR', 'Fetch'])
/** Requests older than this no longer count for settling (it looks back 2.5 s)
 *  and are forgotten, so a long-lived page's unfinished streams do not pile up. */
const REQUEST_MEMORY_MS = 10_000

/** Agent screenshots are JPEG where they can be: PNG encoding took most of
 *  a screenshot, blocking this process, at two to four times the size. */
const SCREENSHOT_QUALITY = 85

/** Whether every pixel of `image` is opaque. */
function opaque(image: Electron.NativeImage): boolean {
  const bitmap = image.toBitmap()
  for (let alpha = 3; alpha < bitmap.length; alpha += 4) if (bitmap[alpha] !== 255) return false
  return true
}

/** How long `upload` waits for the element it clicks to open a file chooser. */
const FILE_CHOOSER_TIMEOUT_MS = 3_000
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** `promise`, or `code` once `ms` pass. The promise itself keeps running. */
function within<T>(promise: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(code)), ms) })])
    .finally(() => clearTimeout(timer))
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function ambiguous(locator: BrowserLocator, matches: BrowserElement[]): Error {
  const listed = matches.slice(0, LOCATOR_LISTED).map(describeBrowserElement)
  if (matches.length > LOCATOR_LISTED) listed.push(`... and ${matches.length - LOCATOR_LISTED} more`)
  return new Error(`browser-ambiguous-element: ${matches.length} elements match ${describeBrowserLocator(locator)}:\n${listed.join('\n')}`)
}

function globMatches(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')
  return new RegExp(`^${escaped}$`).test(value)
}

export class PageDriver {
  readonly contents: WebContents
  identity: BrowserPageIdentity
  private refs = new Map<number, RefTarget>()
  private stableIds = new Map<string, number>()
  private elementCounter = 0
  private observationCounter = 0
  private observations = new BrowserObservationCache()
  private documentEpoch = 0
  private userInputEpoch = 0
  private agentInputDepth = 0
  private queue: Promise<unknown> = Promise.resolve()
  private activeGuard?: () => void
  /** The latest AX observation, the baseline of a call that names none (CLI). */
  private latestAx?: string
  /** Set once a call has sent input or changed the page, for its recovery hint. */
  private inputSent = false
  /** In-flight document and data requests, by request id, with their start time. */
  private requests = new Map<string, number>()
  private readonly frames = new FrameTree()
  private attached = false
  /** A CDP command timed out: the page's main thread does not yield. */
  private hung = false
  private readonly dialogs?: PageDriverOptions['dialogs']
  /** Set while an agent action may open a file chooser: the chooser is
   *  reported to the driver instead of shown. */
  private intercepting = false
  /** The file chooser an agent action opened that no upload answered yet. */
  private fileChooser?: { backendNodeId: number; sessionId?: string; documentEpoch: number }
  private readonly log = new PageLog()
  /** The debugger lets go of a guest whose renderer crashed or restarted:
   *  the next command attaches again. */
  private readonly onDebuggerDetach = (): void => {
    this.contents.debugger.removeListener('message', this.onDebuggerMessage)
    this.contents.debugger.removeListener('detach', this.onDebuggerDetach)
    this.attached = false
    this.hung = false
    this.intercepting = false
    this.frames.clear()
  }
  private readonly onDebuggerMessage = (_event: Electron.Event, method: string, params: unknown, sessionId?: string): void => {
    // The top frame's events come with an empty session id.
    this.handleEvent({ method, params: objectValue(params), sessionId: sessionId || undefined })
  }

  constructor(contents: WebContents, identity: BrowserPageIdentity, options: PageDriverOptions = {}) {
    this.contents = contents
    this.identity = identity
    this.dialogs = options.dialogs
    contents.once('destroyed', () => this.dispose())
  }

  matches(identity: BrowserPageIdentity): boolean {
    return this.identity.panelId === identity.panelId
      && this.identity.tabId === identity.tabId
  }

  updateIdentity(identity: BrowserPageIdentity): void {
    this.identity = identity
  }

  noteUserInput(): void {
    if (this.agentInputDepth > 0) return
    this.userInputEpoch += 1
    // The person's own clicks open the system file chooser.
    if (this.intercepting) void this.interceptFileChooser(false)
  }

  async attach(): Promise<void> {
    if (this.attached || this.contents.isDestroyed()) return
    if (!this.contents.debugger.isAttached()) this.contents.debugger.attach('1.3')
    this.contents.debugger.on('message', this.onDebuggerMessage)
    this.contents.debugger.on('detach', this.onDebuggerDetach)
    this.attached = true
    try {
      await this.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      })
      await Promise.all([
        this.send('Page.enable'),
        this.send('DOM.enable'),
        this.send('Runtime.enable'),
        this.send('Accessibility.enable'),
        this.send('Network.enable'),
        // The guest is rarely the OS-focused view; without this Chromium drops
        // the default action of trusted keys (Enter submitting a form).
        this.send('Emulation.setFocusEmulationEnabled', { enabled: true }),
      ])
    } catch (error) {
      this.onDebuggerDetach()
      throw error
    }
  }

  dispose(): void {
    this.requests.clear()
    this.log.clear()
    this.refs.clear()
    this.stableIds.clear()
    this.observations.clear()
    this.frames.clear()
    if (!this.contents.isDestroyed()) {
      this.contents.debugger.removeListener('message', this.onDebuggerMessage)
      this.contents.debugger.removeListener('detach', this.onDebuggerDetach)
      if (this.contents.debugger.isAttached()) {
        try { this.contents.debugger.detach() } catch { /* target already gone */ }
      }
    }
    this.attached = false
  }

  execute(method: string, args: BrowserArgs): Promise<BrowserDriverResult> {
    if (method === 'dialog') return this.answerDialog(args)
    // A page that waits on a dialog runs nothing else until it is answered.
    const open = this.dialogs?.current(this.contents.id)
    if (open) return Promise.resolve({ error: 'browser-dialog-open', recovery: browserDialogNotice(open), dialog: open })
    if (this.hung) {
      return this.responsive().then(answers => answers
        ? this.execute(method, args)
        : { error: PAGE_UNRESPONSIVE, recovery: browserRecovery(PAGE_UNRESPONSIVE, false) })
    }
    let unsubscribe: (() => void) | undefined
    const interrupted = new Promise<BrowserDriverResult>((resolve) => {
      unsubscribe = this.dialogs?.subscribe((webContentsId, dialog) => {
        if (webContentsId !== this.contents.id || !dialog) return
        const action: BrowserActionOutcome = { method, status: 'dispatched', notices: [browserDialogNotice(dialog)] }
        resolve({ result: { action }, dialog })
      })
    })
    const run = this.enqueue(() => {
      this.inputSent = false
      return this.executeBound(method, args)
    }).catch((error) => {
      const message = error instanceof Error ? error.message : 'browser-command-failed'
      const recovery = browserRecovery(message, this.inputSent)
      return { error: message, ...(recovery ? { recovery } : {}) }
    })
    // The call itself finishes once the dialog is answered; the next call
    // waits for it in the queue.
    return Promise.race([run, interrupted]).finally(() => unsubscribe?.())
  }

  /** Answers the page's open dialog, then observes the page after it. */
  private async answerDialog(args: BrowserArgs): Promise<BrowserDriverResult> {
    if (args.action !== 'accept' && args.action !== 'dismiss') return { error: 'invalid-browser-dialog-action' }
    if (args.text !== undefined && typeof args.text !== 'string') return { error: 'invalid-browser-dialog-text' }
    const dialog = this.dialogs?.answer(this.contents.id, { accept: args.action === 'accept', ...(typeof args.text === 'string' ? { text: args.text } : {}) })
    if (!dialog) return { error: 'browser-no-dialog', recovery: browserRecovery('browser-no-dialog', false) }
    const action: BrowserActionOutcome = { method: 'dialog', status: 'verified', notices: [`${args.action === 'accept' ? 'Accepted' : 'Dismissed'} the ${dialog.type} dialog "${dialog.message}".`] }
    const after = await this.execute('getAXState', {})
    if (after.dialog) return { result: { action: { ...action, notices: [...action.notices!, ...(objectValue(objectValue(after.result).action).notices as string[] ?? [])] } }, dialog: after.dialog }
    return { result: { action, ...(after.result ? { observation: after.result } : {}) } }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    // Capture takeover at submission, so input also invalidates waiting work.
    const epoch = this.userInputEpoch
    const guard = (): void => {
      if (this.contents.isDestroyed()) throw new Error('browser-target-destroyed')
      if (this.userInputEpoch !== epoch) throw new Error('browser-action-preempted-by-user')
    }
    const run = this.queue.then(async () => {
      guard()
      this.activeGuard = guard
      try {
        const result = await operation()
        guard()
        return result
      } finally {
        // Observations retain backend node IDs, never temporary remote objects.
        // Cleanup must also run after takeover or a failed action.
        if (!this.contents.isDestroyed() && this.attached) {
          await Promise.allSettled([undefined, ...this.frames.sessionIds()].map(async sessionId => {
            await this.command('Runtime.releaseObjectGroup', { objectGroup: 'cate-browser' }, sessionId)
          }))
        }
        this.activeGuard = undefined
      }
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Throws once the running call must stop (the user took over). */
  private check(): void {
    this.activeGuard?.()
  }

  async fillCredential(targetId: string, credential: { username: string; password: string }): Promise<{ ok?: true; error?: string }> {
    return this.enqueue(async () => {
      const selector = `[data-cate-autofill-target=${JSON.stringify(targetId)}]`
      await this.fillLogin(await this.resolveSelector(selector), credential)
      return { ok: true as const }
    }).catch((error) => ({ error: error instanceof Error ? error.message : 'credential-fill-failed' }))
  }

  /** Fills a saved login: the username of the password field's form, then
   *  the password. The value never comes back: observations mask it. */
  private async fillLogin(password: ElementTarget, credential: { username: string; password: string }): Promise<void> {
    const username = await this.locate(password, USERNAME_FOR_PASSWORD)
    this.check()
    if (username && credential.username) await this.fillUsername(username, credential.username)
    await this.fillElement(password, credential.password)
  }

  /** A username step already shows the username, often read-only: leave it. */
  private async fillUsername(field: ElementTarget, username: string): Promise<void> {
    if ((await this.callOn(field, 'function () { return this.value; }')).value === username) return
    try {
      await this.fillElement(field, username)
    } catch (error) {
      if (!(error instanceof Error) || !['element-readonly', 'element-disabled'].includes(error.message)) throw error
    }
  }

  /** Fills the saved login the runtime chose (`credential`, saved for
   *  `origin`) into the sign-in form: the target's, or the page's. A step that
   *  asks for the username alone gets the username. */
  private async login(target: ElementTarget | undefined, credential: { username: string; password: string; origin: string }): Promise<string[]> {
    // The page must still show the credential's origin (it may have navigated
    // since the runtime chose), and the field must belong to the page itself,
    // not to a frame of another site.
    if (target?.sessionId) throw new Error('browser-login-origin-mismatch')
    const password = await this.locate(target, PASSWORD_FIELD)
    const field = password ?? await this.locate(target, USERNAME_FIELD)
    if (!field) throw new Error('browser-login-field-not-found')
    const fieldOrigin = (await this.callOn(field, 'function () { return this.ownerDocument.location.origin; }')).value
    let pageOrigin = ''
    try { pageOrigin = new URL(this.contents.getURL()).origin } catch { /* no page */ }
    if (pageOrigin !== credential.origin || fieldOrigin !== pageOrigin) throw new Error('browser-login-origin-mismatch')
    this.check()
    if (password) {
      await this.fillLogin(password, credential)
      return [`Filled the saved login for ${credential.username || 'this site'}; the password is hidden. Submit the form to sign in.`]
    }
    await this.fillUsername(field, credential.username)
    return [`Filled the username ${credential.username}; this step asks for no password. Continue, then run login again on the password step.`]
  }

  /** The element `declaration` returns, called on `scope` or the main document. */
  private async locate(scope: ElementTarget | undefined, declaration: string): Promise<ElementTarget | undefined> {
    let result: Record<string, unknown>
    if (scope) result = await this.callOn(scope, declaration, false)
    else {
      const response = await this.send('Runtime.evaluate', { expression: `(${declaration}).call(document)`, objectGroup: 'cate-browser', returnByValue: false })
      if (response.exceptionDetails) throw new Error('page-evaluation-failed')
      result = objectValue(response.result)
    }
    if (typeof result.objectId !== 'string' || result.subtype === 'null') return undefined
    const node = objectValue((await this.send('DOM.describeNode', { objectId: result.objectId }, scope?.sessionId)).node)
    if (typeof node.backendNodeId !== 'number') return undefined
    return { objectId: result.objectId, backendNodeId: node.backendNodeId, frameId: scope?.frameId, sessionId: scope?.sessionId }
  }

  /** Reports file choosers to the driver (`Page.fileChooserOpened`) instead
   *  of showing them, in every frame. */
  private async interceptFileChooser(enabled: boolean): Promise<void> {
    if (this.intercepting === enabled || this.contents.isDestroyed() || !this.attached) return
    this.intercepting = enabled
    await Promise.allSettled([undefined, ...this.frames.sessionIds()].map(sessionId =>
      this.command('Page.setInterceptFileChooserDialog', { enabled }, sessionId)))
  }

  private handleEvent(event: CdpEvent): void {
    this.log.record(event)
    if (event.method === 'Page.fileChooserOpened') {
      if (this.intercepting && typeof event.params.backendNodeId === 'number') {
        this.fileChooser = { backendNodeId: event.params.backendNodeId, sessionId: event.sessionId, documentEpoch: this.documentEpoch }
      }
      return
    }
    if (event.method === 'Target.attachedToTarget') {
      const targetInfo = objectValue(event.params.targetInfo)
      const sessionId = typeof event.params.sessionId === 'string' ? event.params.sessionId : undefined
      const frameId = typeof targetInfo.targetId === 'string' ? targetInfo.targetId : undefined
      if (targetInfo.type === 'iframe' && sessionId && frameId) {
        this.frames.attachSession(frameId, sessionId)
        void this.enableSession(sessionId)
      }
      return
    }
    if (event.method === 'Target.detachedFromTarget') {
      const sessionId = typeof event.params.sessionId === 'string' ? event.params.sessionId : undefined
      if (sessionId) this.dropFrameSession(sessionId)
      return
    }
    if (event.method === 'Network.requestWillBeSent') {
      if (!event.sessionId && typeof event.params.requestId === 'string' && SETTLE_REQUEST_TYPES.has(String(event.params.type))) {
        const now = Date.now()
        for (const [id, at] of this.requests) if (now - at > REQUEST_MEMORY_MS) this.requests.delete(id)
        this.requests.set(event.params.requestId, now)
      }
      return
    }
    if (event.method === 'Network.loadingFinished' || event.method === 'Network.loadingFailed') {
      if (!event.sessionId && typeof event.params.requestId === 'string') this.requests.delete(event.params.requestId)
      return
    }
    if (event.method === 'Page.frameAttached') {
      const frameId = typeof event.params.frameId === 'string' ? event.params.frameId : undefined
      const parentFrameId = typeof event.params.parentFrameId === 'string' ? event.params.parentFrameId : undefined
      if (frameId) this.frames.setParent(frameId, parentFrameId)
      return
    }
    if (event.method === 'Page.frameDetached') {
      const frameId = typeof event.params.frameId === 'string' ? event.params.frameId : undefined
      if (frameId) this.dropFrame(frameId)
      return
    }
    if (event.method === 'Page.frameNavigated') {
      const frame = objectValue(event.params.frame)
      const frameId = typeof frame.id === 'string' ? frame.id : this.frames.frameOfSession(event.sessionId ?? '')
      const parentId = typeof frame.parentId === 'string' ? frame.parentId : this.frames.parent(frameId ?? '')
      if (!event.sessionId && !parentId) {
        this.documentEpoch += 1
        this.fileChooser = undefined
        this.requests.clear()
        this.refs.clear()
        this.stableIds.clear()
        this.frames.clearParents()
      } else if (frameId) {
        this.frames.setParent(frameId, parentId)
        this.dropRefsForFrame(frameId, event.sessionId)
      }
      return
    }
  }

  private async enableSession(sessionId: string): Promise<void> {
    try {
      await Promise.all([
        this.send('Page.enable', {}, sessionId),
        this.send('DOM.enable', {}, sessionId),
        this.send('Runtime.enable', {}, sessionId),
        this.send('Accessibility.enable', {}, sessionId),
        this.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId),
        ...(this.intercepting ? [this.send('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId)] : []),
      ])
    } catch {
      this.dropFrameSession(sessionId)
    }
  }

  private dropRefsForFrame(frameId: string, sessionId?: string): void {
    for (const [ref, target] of this.refs) {
      if (target.frameId === frameId || (sessionId && target.sessionId === sessionId)) {
        this.refs.delete(ref)
        this.stableIds.delete(`${target.sessionId ?? 'root'}:${target.backendNodeId}`)
      }
    }
  }

  private dropFrame(frameId: string): void {
    this.dropRefsForFrame(frameId, this.frames.ownSession(frameId))
    this.frames.drop(frameId)
  }

  private dropFrameSession(sessionId: string): void {
    const frameId = this.frames.frameOfSession(sessionId)
    if (frameId) this.dropFrame(frameId)
    else this.dropRefsForFrame('', sessionId)
  }

  /** One CDP command. A page whose main thread never yields (a script in an
   *  endless loop) answers none: the command fails after CDP_TIMEOUT_MS and
   *  the page counts as hung, failing every command at once until it answers
   *  a probe again (`execute`) or restarts (`restartIfHung`). */
  private async command(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = CDP_TIMEOUT_MS): Promise<Record<string, unknown>> {
    if (this.hung && timeoutMs === CDP_TIMEOUT_MS) throw new Error(PAGE_UNRESPONSIVE)
    try {
      const result = objectValue(await within(this.contents.debugger.sendCommand(method, params, sessionId), timeoutMs, PAGE_UNRESPONSIVE))
      this.hung = false
      return result
    } catch (error) {
      if (error instanceof Error && error.message === PAGE_UNRESPONSIVE) this.hung = true
      throw error
    }
  }

  private async send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    await this.attach()
    // Always allow paired releases so takeover cannot leave a button/key held.
    // Session setup also runs from debugger events, independently of commands.
    const releasingInput = method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased'
    const setup = method.endsWith('.enable') || method === 'Target.setAutoAttach' || method === 'Emulation.setFocusEmulationEnabled' || method === 'Page.setInterceptFileChooserDialog'
    if (!releasingInput && !setup) this.activeGuard?.()
    try {
      return await this.command(method, params, sessionId)
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'CDP command failed'
      if (detail === PAGE_UNRESPONSIVE) throw error
      throw new Error(`${method}: ${detail}`)
    }
  }

  /** Whether the page answers again after it hung. */
  private async responsive(): Promise<boolean> {
    if (!this.hung) return true
    try {
      await this.command('Runtime.evaluate', { expression: '1', returnByValue: true }, undefined, 1_000)
      return true
    } catch {
      return false
    }
  }

  /** Restarts a hung page: its renderer is killed and the page loads again.
   *  False when the page is not hung. */
  async restartIfHung(): Promise<boolean> {
    if (!this.hung || this.contents.isDestroyed()) return false
    this.hung = false
    // A reload before the old renderer is gone does nothing.
    const gone = new Promise<void>(resolve => { this.contents.once('render-process-gone', () => resolve()) })
    this.contents.forcefullyCrashRenderer()
    await within(gone, RESTART_TIMEOUT_MS, 'browser-restart-timeout').catch(() => {})
    if (!this.contents.isDestroyed()) this.contents.reload()
    return true
  }

  /** Dispatch trusted input to this guest while marking the resulting DOM
   * events as agent-originated for the tiny guest preload. Without the marker,
   * the user-preemption listener would cancel the action on its own click. */
  private async dispatchInput(params: Record<string, unknown>): Promise<void> {
    this.inputSent = true
    this.agentInputDepth += 1
    this.contents.send('cate-browser-automation-input', true)
    try {
      if (params.type === 'mouseWheel') await this.dispatchWheel(params)
      else await this.send('Input.dispatchMouseEvent', params)
    } finally {
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (!this.contents.isDestroyed()) this.contents.send('cate-browser-automation-input', false)
      this.agentInputDepth -= 1
    }
  }

  private async dispatchWheel(params: Record<string, unknown>): Promise<void> {
    const watches: Array<{ objectId: string; sessionId?: string }> = []
    try {
      // A queued wheel command can return before the trusted event reaches a
      // hidden guest. Listen in each frame's isolated world before dispatch,
      // then keep input marked until the receiving document finishes handling it.
      for (const frameId of await this.currentFrameIds()) {
        const sessionId = this.frames.ownSession(frameId)
        const world = await this.send('Page.createIsolatedWorld', { frameId, worldName: 'cate-browser-input' }, sessionId)
        const response = await this.send('Runtime.evaluate', {
          contextId: world.executionContextId, objectGroup: 'cate-browser', returnByValue: false,
          expression: `(() => {
            let listener, timer, finish;
            const promise=new Promise(resolve=>{
              finish=value=>{clearTimeout(timer);document.removeEventListener('wheel',listener,true);resolve(value);};
              listener=event=>{
                if(!event.isTrusted)return;
                document.removeEventListener('wheel',listener,true);
                // The next task runs after this event's default handling.
                clearTimeout(timer);timer=setTimeout(()=>finish(true),0);
              };
              document.addEventListener('wheel',listener,{capture:true,passive:true});
              timer=setTimeout(()=>finish(false),5000);
            });
            return {promise,cancel:()=>finish(false)};
          })()`,
        }, sessionId)
        const objectId = objectValue(response.result).objectId
        if (typeof objectId !== 'string') throw new Error('browser-wheel-listener-failed')
        watches.push({ objectId, sessionId })
      }
      if (!watches.length) throw new Error('browser-wheel-frame-required')
      const completion = Promise.any(watches.map(async watch => {
        const response = await this.send('Runtime.callFunctionOn', {
          objectId: watch.objectId, functionDeclaration: 'function () { return this.promise; }', awaitPromise: true, returnByValue: true,
        }, watch.sessionId)
        if (objectValue(response.result).value !== true) throw new Error('browser-wheel-event-timeout')
      }))
      // Install rejection handling even when input dispatch itself fails.
      void completion.catch(() => {})
      await this.send('Input.dispatchMouseEvent', params)
      try { await completion } catch { throw new Error('browser-wheel-event-timeout') }
    } finally {
      await Promise.allSettled(watches.map(async watch => {
        await this.command('Runtime.callFunctionOn', {
          objectId: watch.objectId, functionDeclaration: 'function () { this.cancel(); }', returnByValue: true,
        }, watch.sessionId)
      }))
    }
  }

  /** Sends key events to this guest's own widget. Input.dispatchKeyEvent
   *  would deliver them to the window's focused guest, whichever that is (and
   *  drop them while none is), and a key press must not take the user's focus. */
  private async dispatchKey(events: Electron.KeyboardInputEvent[], command?: string): Promise<void> {
    this.inputSent = true
    this.agentInputDepth += 1
    this.contents.send('cate-browser-automation-input', true)
    try {
      // A page that handles the shortcut itself cancels its keydown.
      const cancelled = command ? await this.watchKeydownCancel() : undefined
      sendingKeys.add(this.contents)
      try {
        for (const event of events) this.contents.sendInputEvent(event)
      } finally {
        sendingKeys.delete(this.contents)
      }
      if (command && !await cancelled?.()) await this.editingCommand(command)
      // The guest handles input in order: once a task runs, the keys are in.
      await this.evaluate('new Promise(resolve => setTimeout(() => resolve(true), 0))')
    } finally {
      if (!this.contents.isDestroyed()) this.contents.send('cate-browser-automation-input', false)
      this.agentInputDepth -= 1
    }
  }

  /** Listens for the next keydown in the main frame; the returned call
   *  resolves to whether the page cancelled it. */
  private async watchKeydownCancel(): Promise<() => Promise<boolean>> {
    const tree = objectValue(await this.send('Page.getFrameTree'))
    const frameId = objectValue(objectValue(tree.frameTree).frame).id
    const world = await this.send('Page.createIsolatedWorld', { frameId, worldName: 'cate-browser-input' })
    const watch = await this.send('Runtime.evaluate', {
      contextId: world.executionContextId, objectGroup: 'cate-browser', returnByValue: false,
      expression: `new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), 1000);
        addEventListener('keydown', event => { clearTimeout(timer); setTimeout(() => resolve(event.defaultPrevented), 0); }, { capture: true, once: true });
      })`,
    })
    const objectId = objectValue(watch.result).objectId
    return async () => {
      if (typeof objectId !== 'string') return false
      const result = await this.send('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function () { return this; }', awaitPromise: true, returnByValue: true })
      return objectValue(result.result).value === true
    }
  }

  /** Runs a macOS editing command in the focused field (MAC_EDITING_COMMANDS). */
  private async editingCommand(command: string): Promise<void> {
    const pasted = command === 'paste' ? clipboard.readText() : ''
    const copied = await this.evaluate(`(() => {
      let doc = document;
      while (doc.activeElement && doc.activeElement.contentDocument) doc = doc.activeElement.contentDocument;
      const field = doc.activeElement, selection = doc.getSelection();
      const inField = field && typeof field.selectionStart === 'number';
      const selected = () => inField ? field.value.slice(field.selectionStart, field.selectionEnd) : String(selection);
      const line = (alter, direction) => { selection.modify(alter, direction, 'lineboundary'); if (alter === 'extend') doc.execCommand('delete'); };
      switch (${JSON.stringify(command)}) {
        case 'selectAll': if (inField) field.select(); else doc.execCommand('selectAll'); return null;
        case 'copy': return selected();
        case 'cut': { const text = selected(); doc.execCommand('delete'); return text; }
        case 'paste': doc.execCommand('insertText', false, ${JSON.stringify(pasted)}); return null;
        case 'undo': case 'redo': doc.execCommand(${JSON.stringify(command)}); return null;
        case 'deleteToBeginningOfLine': line('extend', 'backward'); return null;
        case 'moveToBeginningOfLine': line('move', 'backward'); return null;
        case 'moveToEndOfLine': line('move', 'forward'); return null;
      }
    })()`)
    if (typeof copied === 'string' && copied) clipboard.writeText(copied)
  }

  private async resolveSelector(selector: string): Promise<ElementTarget> {
    const response = await this.send('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
      objectGroup: 'cate-browser',
      returnByValue: false,
    })
    const result = objectValue(response.result)
    const objectId = typeof result.objectId === 'string' ? result.objectId : undefined
    if (!objectId || result.subtype === 'null') throw new Error('element-not-found')
    const described = await this.send('DOM.describeNode', { objectId })
    const node = objectValue(described.node)
    if (typeof node.backendNodeId !== 'number') throw new Error('element-not-found')
    return { objectId, backendNodeId: node.backendNodeId }
  }

  private async callOn(target: ElementTarget, functionDeclaration: string, returnByValue = true, executionContextId?: number): Promise<Record<string, unknown>> {
    let objectId = target.objectId
    if (!objectId) {
      const resolved = await this.send('DOM.resolveNode', { backendNodeId: target.backendNodeId, objectGroup: 'cate-browser', ...(executionContextId === undefined ? {} : { executionContextId }) }, target.sessionId)
      objectId = typeof objectValue(resolved.object).objectId === 'string'
        ? objectValue(resolved.object).objectId as string
        : undefined
    }
    if (!objectId) throw new Error('element-not-found')
    const response = await this.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration,
      returnByValue,
      awaitPromise: true,
    }, target.sessionId)
    const exception = objectValue(response.exceptionDetails)
    if (response.exceptionDetails) {
      const detail = String(objectValue(exception.exception).description ?? exception.text ?? '').split('\n')[0]
      throw new Error(detail ? `page-evaluation-failed: ${detail}` : 'page-evaluation-failed')
    }
    return objectValue(response.result)
  }

  /** The element a pointer action lands on: a text node's element, or the
   *  visible label of a checkbox or radio that styling hides. */
  private async pointerTarget(target: ElementTarget): Promise<ElementTarget> {
    const result = await this.callOn(target, `function () {
      const element = this.nodeType === Node.ELEMENT_NODE ? this : this.parentElement;
      if (!element) return null;
      const shown = node => node.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && Array.from(node.getClientRects()).some(rect => rect.width > 0 && rect.height > 0);
      if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio') && !shown(element)) {
        return Array.from(element.labels || []).find(shown) || element;
      }
      return element;
    }`, false)
    if (typeof result.objectId !== 'string') throw new Error('element-not-found')
    const described = objectValue((await this.send('DOM.describeNode', { objectId: result.objectId }, target.sessionId)).node)
    if (typeof described.backendNodeId !== 'number') throw new Error('element-not-found')
    if (described.backendNodeId === target.backendNodeId) return target
    return { objectId: result.objectId, backendNodeId: described.backendNodeId, frameId: target.frameId, sessionId: target.sessionId }
  }

  private async box(target: ElementTarget, scroll = true): Promise<{ x: number; y: number; width: number; height: number }> {
    if (scroll) await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: target.backendNodeId }, target.sessionId)
    const response = await this.send('DOM.getBoxModel', { backendNodeId: target.backendNodeId }, target.sessionId)
    const content = objectValue(response.model).content
    if (!Array.isArray(content) || content.length < 8) throw new Error('element-has-no-actionable-box')
    const xs = [Number(content[0]), Number(content[2]), Number(content[4]), Number(content[6])]
    const ys = [Number(content[1]), Number(content[3]), Number(content[5]), Number(content[7])]
    const local = {
      x: Math.min(...xs), y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys),
    }
    if (!target.sessionId || !target.frameId) return local
    const offset = await this.frameOffset(target.frameId, scroll)
    return { ...local, x: local.x + offset.x, y: local.y + offset.y }
  }

  private async frameOffset(frameId: string, scroll: boolean): Promise<{ x: number; y: number }> {
    let x = 0, y = 0, current: string | undefined = frameId
    const seen = new Set<string>()
    while (current && !seen.has(current)) {
      seen.add(current)
      const parent = this.frames.parent(current)
      if (!parent) break
      const parentSession = this.frames.sessionOf(parent)
      const owner = await this.send('DOM.getFrameOwner', { frameId: current }, parentSession)
      const backendNodeId = objectValue(owner).backendNodeId
      if (typeof backendNodeId !== 'number') break
      if (scroll) await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }, parentSession)
      const model = await this.send('DOM.getBoxModel', { backendNodeId }, parentSession)
      const content = objectValue(model.model).content
      if (!Array.isArray(content) || content.length < 8) break
      x += Math.min(Number(content[0]), Number(content[2]), Number(content[4]), Number(content[6]))
      y += Math.min(Number(content[1]), Number(content[3]), Number(content[5]), Number(content[7]))
      current = parent
    }
    return { x, y }
  }

  private cursor(box: { x: number; y: number; width: number; height: number }, label: string, kind: CursorKind): NonNullable<BrowserDriverResult['cursor']> {
    return {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      label,
      kind,
    }
  }

  /** Waits up to `timeoutMs` for `target` to be stable, visible, enabled and
   *  uncovered, and returns its box. */
  private async actionableBox(target: ElementTarget, timeoutMs = ACTIONABLE_TIMEOUT_MS): Promise<{ x: number; y: number; width: number; height: number }> {
    const deadline = Date.now() + timeoutMs
    let obscured = 0
    for (let attempt = 0; ; attempt++) {
      try {
        const box = await this.box(target)
        await this.nextFrames()
        this.check()
        const settled = await this.box(target, false)
        if (Object.keys(box).some((key) => Math.abs(box[key as keyof typeof box] - settled[key as keyof typeof settled]) > 0.5)) {
          throw new Error('element-not-stable')
        }
        const actionable = await this.callOn(target, `function () {
          if (!this.isConnected || !this.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return 'element-not-visible';
          if (this.matches(':disabled') || this.closest('[aria-disabled="true"],[inert]')) return 'element-disabled';
          const rect=this.getBoundingClientRect(), x=rect.x+rect.width/2, y=rect.y+rect.height/2;
          if (rect.width<=0 || rect.height<=0) return 'element-has-no-actionable-box';
          const describe=(node)=>{
            const role=node.getAttribute('role'), label=node.getAttribute('aria-label')||node.innerText||node.textContent||'';
            const text=label.replace(/\\s+/g,' ').trim().slice(0,60);
            return '<'+node.localName+(node.id?'#'+node.id:'')+(role?' role='+role:'')+'>'+(text?' "'+text+'"':'');
          };
          for(let target=this;target;) {
            const root=target.getRootNode(), hit=root.elementFromPoint(x,y);
            if(!hit) return 'element-obscured';
            if(hit!==target && !target.contains(hit)) {
              const cover=hit.closest('dialog,[role=dialog],[role=alertdialog],[aria-modal=true]')||hit;
              return 'element-obscured: covered by '+describe(cover);
            }
            target=root.host;
          }
          return true;
        }`)
        if (actionable.value !== true) throw new Error(typeof actionable.value === 'string' ? actionable.value : 'element-not-actionable')
        this.check()
        return settled
      } catch (error) {
        this.check()
        const code = error instanceof Error ? error.message.split(':')[0] : ''
        if (!TRANSIENT_ELEMENT_ERRORS.includes(code) || Date.now() >= deadline) throw error
        // Scrolling into view can leave the element under a sticky header or
        // footer: try the other alignments before waiting for the cover to go.
        if (code === 'element-obscured') {
          const block = OBSCURED_SCROLL_ALIGNMENTS[obscured++ % OBSCURED_SCROLL_ALIGNMENTS.length]
          await this.callOn(target, `function () { this.scrollIntoView({ block: ${JSON.stringify(block)}, inline: 'center' }); }`).catch(() => {})
        }
        await sleep(Math.min(100 * 2 ** attempt, 500))
      }
    }
  }

  /** Two rendered frames, or 50 ms when the page renders none (hidden). */
  private async nextFrames(): Promise<void> {
    await within(this.evaluate(`new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), 50);
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(true); }));
    })`), 1000, 'element-not-stable')
  }

  private async clickElement(target: ElementTarget, count = 1, button = 'left', timeoutMs?: number): Promise<ReturnType<PageDriver['cursor']>> {
    target = await this.pointerTarget(target)
    const settled = await this.actionableBox(target, timeoutMs)
    const x = settled.x + settled.width / 2
    const y = settled.y + settled.height / 2
    await this.dispatchInput({ type: 'mouseMoved', x, y })
    this.check()
    try {
      await this.dispatchInput({ type: 'mousePressed', x, y, button, clickCount: count })
    } finally {
      await this.dispatchInput({ type: 'mouseReleased', x, y, button, clickCount: count })
    }
    this.check()
    return this.cursor(settled, count === 2 ? 'dblclick' : 'click', count === 2 ? 'dblclick' : 'click')
  }

  private async assertEditable(target: ElementTarget): Promise<void> {
    const result = await this.callOn(target, `function () {
      if(this.matches(':disabled') || this.closest('[aria-disabled="true"],[inert]')) return 'element-disabled';
      if(this.readOnly || this.getAttribute('aria-readonly')==='true') return 'element-readonly';
      if(this.isContentEditable || this instanceof HTMLTextAreaElement || (this instanceof HTMLInputElement && !['button','checkbox','color','file','hidden','image','radio','range','reset','submit'].includes(this.type))) return true;
      return 'element-not-editable';
    }`)
    if (result.value !== true) throw new Error(typeof result.value === 'string' ? result.value : 'element-not-editable')
  }

  /** Inserts text at the selection of the focused field, like typing, without
   *  focusing the guest in the host window (the terminal keeps its focus): an
   *  editor that handles `beforeinput` itself (Lexical, Slate) takes it there,
   *  anything else gets the browser's own insertion. */
  private async insertText(target: ElementTarget, text: string): Promise<void> {
    this.inputSent = true
    await this.callOn(target, `function () {
      const text=${JSON.stringify(text)};
      const event=new InputEvent('beforeinput',{inputType:'insertText',data:text,bubbles:true,cancelable:true,composed:true});
      if (this.dispatchEvent(event)) this.ownerDocument.execCommand('insertText',false,text);
    }`)
  }

  private async focusElement(target: ElementTarget): Promise<void> {
    await this.send('DOM.focus', { backendNodeId: target.backendNodeId }, target.sessionId)
  }

  private async fillElement(target: ElementTarget, text: string): Promise<void> {
    await this.assertEditable(target)
    await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: target.backendNodeId }, target.sessionId)
    // Focus stays inside this CDP target's document. It does not activate the
    // Electron window, so xterm/Monaco focus in the host remains untouched.
    await this.focusElement(target)
    this.check()
    this.inputSent = true
    const editable = await this.callOn(target, `function () {
      const text=${JSON.stringify(text)};
      if (this.isContentEditable) {
        // Rich editors keep their own model: select everything and replace it
        // through trusted input below, never by rewriting the DOM.
        const range=this.ownerDocument.createRange();range.selectNodeContents(this);
        const selection=this.ownerDocument.getSelection();selection.removeAllRanges();selection.addRange(range);
        return true;
      }
      const proto=this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;
      if (setter) setter.call(this,text); else this.value=text;
      this.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
      this.dispatchEvent(new Event('change',{bubbles:true}));
      return false;
    }`)
    this.check()
    if (editable.value === true) {
      if (text) await this.insertText(target, text)
      else await this.callOn(target, 'function () { this.ownerDocument.execCommand("delete"); }')
      this.check()
      const observed = await this.callOn(target, 'function () { return this.innerText; }')
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
      if (typeof observed.value === 'string' && normalize(observed.value) !== normalize(text)) throw new Error('browser-fill-postcondition-failed')
      return
    }
    const observed = await this.callOn(target, 'function () { return this.value; }')
    if (typeof observed.value === 'string' && observed.value !== text) throw new Error('browser-fill-postcondition-failed')
  }

  private async typeElement(target: ElementTarget | null, text: string): Promise<void> {
    if (!target) throw new Error('type-target-required')
    await this.assertEditable(target)
    this.check()
    const content = 'function () { return this.isContentEditable ? this.innerText : this.value; }'
    const before = await this.callOn(target, `function () { return this.matches(':focus') ? (${content}).call(this) : null; }`)
    if (typeof before.value !== 'string') throw new Error('browser-type-target-not-focused')
    if (!text) return
    await this.insertText(target, text)
    this.check()
    const after = await this.callOn(target, content)
    if (after.value === before.value) throw new Error('browser-type-failed')
  }

  /** Sets `files` on the file input `target` stands for (its label, a
   *  wrapper), or on the input whose chooser it opens when clicked; without
   *  a target, on the chooser an earlier action opened. */
  private async uploadFiles(target: ElementTarget | undefined, files: string[]): Promise<string[]> {
    let input = target && await this.locate(target, FILE_INPUT_OF)
    if (!input && target) {
      // A styled button or drop area that opens the chooser from script.
      this.fileChooser = undefined
      await this.interceptFileChooser(true)
      try {
        await this.clickElement(target, 1, 'left')
        const deadline = Date.now() + FILE_CHOOSER_TIMEOUT_MS
        while (!this.fileChooser && Date.now() < deadline) { this.check(); await sleep(50) }
      } finally {
        await this.interceptFileChooser(false)
      }
    }
    if (!input) {
      const chooser = this.fileChooser
      if (!chooser || chooser.documentEpoch !== this.documentEpoch) throw new Error('browser-upload-no-file-chooser')
      input = { backendNodeId: chooser.backendNodeId, sessionId: chooser.sessionId }
    }
    this.fileChooser = undefined
    const state = objectValue((await this.callOn(input, `function () {
      return { file: this instanceof HTMLInputElement && this.type === 'file', enabled: !this.disabled, multiple: this.multiple === true };
    }`)).value)
    if (state.file !== true) throw new Error('browser-upload-no-file-chooser')
    if (state.enabled !== true) throw new Error('element-disabled')
    if (files.length > 1 && state.multiple !== true) throw new Error('browser-upload-single-file-input')
    this.check()
    this.inputSent = true
    await this.send('DOM.setFileInputFiles', { files, backendNodeId: input.backendNodeId }, input.sessionId)
    this.check()
    const observed = await this.callOn(input, 'function () { return Array.from(this.files || [], file => file.name); }')
    if (!Array.isArray(observed.value) || observed.value.length !== files.length) throw new Error('browser-upload-postcondition-failed')
    return observed.value.map(String)
  }

  /** Drops `files` on a drop area, as dragging them from the desktop does. */
  private async dropFiles(x: number, y: number, files: string[]): Promise<void> {
    const data = { items: [], files, dragOperationsMask: 1 }
    this.inputSent = true
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      this.check()
      await this.send('Input.dispatchDragEvent', { type, x, y, data })
    }
  }

  private async pressKey(keySpec: string): Promise<void> {
    const press = parseKey(keySpec)
    if ('scrollPage' in press) {
      this.check()
      await this.evaluate(`scrollBy(0, ${press.scrollPage} * innerHeight); true`)
      return
    }
    await this.dispatchKey(press.events, press.command)
    this.check()
  }

  /** The page's frames, the main frame first. */
  private async currentFrameIds(): Promise<string[]> {
    return this.frames.record((await this.send('Page.getFrameTree')).frameTree)
  }

  private async readAXState(viewport: BrowserViewportState): Promise<{ state: string; elements: BrowserElement[] }> {
    const frameIds = await this.currentFrameIds()
    if (!frameIds.length) throw new Error('browser-frame-unavailable')
    return readBrowserAX({
      frames: frameIds.map(frameId => {
        const parentFrameId = this.frames.parent(frameId)
        return { frameId, sessionId: this.frames.ownSession(frameId), parentFrameId, parentSessionId: this.frames.sessionOf(parentFrameId) }
      }),
      viewport,
      send: (method, params, sessionId) => this.send(method, params, sessionId),
      register: target => {
        const identity = `${target.sessionId ?? 'root'}:${target.backendNodeId}`
        let id = this.stableIds.get(identity)
        if (id === undefined) { id = ++this.elementCounter; this.stableIds.set(identity, id) }
        this.refs.set(id, { ...target, documentEpoch: this.documentEpoch })
        return id
      },
    })
  }

  private async evaluate(expression: string): Promise<unknown> {
    const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (response.exceptionDetails) throw new Error('page-evaluation-failed')
    return objectValue(response.result).value ?? null
  }

  private get documentId(): string { return `${this.contents.id}:d${this.documentEpoch}` }

  private async viewport(): Promise<BrowserViewportState> {
    const value = objectValue(await this.evaluate('({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio,scrollX,scrollY})'))
    return {
      width: Number(value.width), height: Number(value.height), deviceScaleFactor: Number(value.deviceScaleFactor),
      zoom: this.contents.getZoomFactor(), scrollX: Number(value.scrollX), scrollY: Number(value.scrollY),
    }
  }

  private sameViewport(a: BrowserViewportState, b: BrowserViewportState): boolean {
    return Object.keys(a).every(key => a[key as keyof BrowserViewportState] === b[key as keyof BrowserViewportState])
  }

  private async captureViewport(viewport: BrowserViewportState, profile?: BrowserObservationPerformance, hidden = false): Promise<BrowserImage> {
    // A hidden guest (its panel parked off screen, or behind another tab or
    // window) paints no frames, and capturing it can wait forever.
    if (hidden || await this.evaluate('document.visibilityState') === 'hidden') throw new Error('browser-page-hidden')
    // Layout/zoom values can update before Chromium submits their pixels.
    // One rAF runs before paint; the next gives that frame a chance to submit
    // before Electron immediately copies the current compositor surface.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        let started = performance.now()
        const frameReady = await within(this.evaluate(`new Promise(resolve => {
          let settled = false;
          const finish = value => { if (!settled) { settled = true; resolve(value); } };
          requestAnimationFrame(() => requestAnimationFrame(() => finish(true)));
          setTimeout(() => finish(false), 3000);
        })`), 3000, 'browser-render-frame-timeout')
        if (frameReady !== true) throw new Error('browser-render-frame-timeout')
        if (profile) profile.frameWaitMs += performance.now() - started
        this.check()
        started = performance.now()
        const capture = await within(this.contents.capturePage(undefined, { stayHidden: true, stayAwake: true }), 5000, 'browser-screenshot-timeout')
        if (profile) profile.captureMs += performance.now() - started
        started = performance.now()
        const resized = capture.resize({ width: Math.round(viewport.width), height: Math.round(viewport.height) })
        if (profile) profile.resizeMs += performance.now() - started
        started = performance.now()
        const size = resized.getSize()
        // JPEG has no alpha: a page that leaves its background transparent
        // stays PNG (flattening it onto white drops the display's colour profile).
        const jpeg = opaque(resized)
        const data = jpeg ? resized.toJPEG(SCREENSHOT_QUALITY) : resized.toPNG()
        if (profile) { profile.encodeMs += performance.now() - started; profile.imageBytes = data.length }
        started = performance.now()
        const encoded = data.toString('base64')
        if (profile) profile.base64Ms += performance.now() - started
        return { mimeType: jpeg ? 'image/jpeg' : 'image/png', data: encoded, width: size.width, height: size.height }
      } catch (error) {
        if (attempt === 1) throw error
        // Navigation can leave the old execution context or compositor frame
        // unavailable for one turn. Let it settle and make one fresh attempt.
        if (!(error instanceof Error) || !/browser-render-frame-timeout|Execution context was destroyed/i.test(error.message)) throw error
        await sleep(50)
      }
    }
    throw new Error('browser-screenshot-failed')
  }

  /** After an action: waits for the navigation or requests it started and
   *  for the DOM to go quiet, so the returned state shows its effect. */
  private async settle(epoch: number, startedAt: number, url: string): Promise<void> {
    const deadline = Date.now() + 5000
    const busy = () => this.contents.isLoading()
      || [...this.requests.values()].some(at => at >= startedAt - 50 && Date.now() - at < 2500)
    const routedNow = () => epoch === this.documentEpoch && this.contents.getURL() !== url
    // The quiet wait starts at once. Requests, a navigation or a route change
    // the action started meanwhile get another round after it.
    let routeWaited = false
    for (;;) {
      while (!this.contents.isDestroyed() && busy() && Date.now() < deadline) {
        this.check()
        await sleep(50)
      }
      this.check()
      if (this.contents.isDestroyed() || (epoch !== this.documentEpoch && this.contents.isLoading())) return
      // A client-side route change (same document, new URL) often renders a
      // moment later: wait for its first change before waiting for quiet.
      const routed: boolean = !routeWaited && routedNow()
      routeWaited ||= routed
      await within(this.evaluate(`new Promise(resolve => {
        let quiet;
        const done = () => { observer.disconnect(); clearTimeout(quiet); clearTimeout(cap); resolve(true); };
        const observer = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(done, 100); });
        observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        if (!${routed}) quiet = setTimeout(done, 100);
        const cap = setTimeout(done, 1000);
      })`), 1500, 'settle-timeout').catch(() => { /* a busy or navigating page still gets observed */ })
      this.check()
      if (this.contents.isDestroyed() || Date.now() >= deadline || (!busy() && (routeWaited || !routedNow()))) return
    }
  }

  private async observe(args: BrowserArgs = {}, screenshot = false, imageOnly = false): Promise<BrowserObservation> {
    const started = performance.now()
    const profile: BrowserObservationPerformance | undefined = args.profile === true ? {
      axMs: 0, frameWaitMs: 0, captureMs: 0, resizeMs: 0, encodeMs: 0, base64Ms: 0,
      totalMs: 0, imageBytes: 0, cacheEntries: 0, cacheEstimatedBytes: 0,
    } : undefined
    const baseline = typeof args.observationId === 'string' ? this.observations.get(args.observationId) : undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      const documentId = this.documentId
      const before = await this.viewport()
      // The tree and the pixels are read at once: the page builds its tree
      // while this process encodes the image.
      const axStarted = performance.now()
      const [ax, { image, screenshotError }] = await Promise.all([
        imageOnly ? { state: '', elements: [] } : this.readAXState(before).finally(() => {
          if (profile) profile.axMs += performance.now() - axStarted
        }),
        screenshot
          ? this.captureViewport(before, profile, args._hidden === true).then((image): Pixels => ({ image }), (error: unknown): Pixels => {
            // The tree is still worth returning when only the pixels are missing.
            if (imageOnly || !(error instanceof Error) || !/^browser-(page-hidden|render-frame-timeout|screenshot-timeout)/.test(error.message)) throw error
            return { screenshotError: error.message }
          })
          : {} as Pixels,
      ])
      const after = await this.viewport()
      if (documentId !== this.documentId || !this.sameViewport(before, after)) continue
      let state = ax.state
      const diff = !imageOnly && args.disableDiffing !== true && baseline?.kind === 'ax' && baseline.documentId === documentId
      if (diff) state = diffBrowserState(baseline.state, state)
      const observation: BrowserObservation = {
        kind: imageOnly ? 'image' : 'ax',
        panelId: this.identity.panelId, tabId: this.identity.tabId, observationId: `${documentId}:o${++this.observationCounter}`,
        documentId, url: this.contents.getURL(), title: this.contents.getTitle(), viewport: after,
        state, elements: ax.elements, diff: Boolean(diff), ...(image ? { screenshot: image } : {}), ...(screenshotError ? { screenshotError } : {}), ...(profile ? { performance: profile } : {}),
      }
      this.observations.set(observation, ax.state)
      if (!imageOnly) this.latestAx = observation.observationId
      if (profile) {
        profile.cacheEntries = this.observations.size
        profile.cacheEstimatedBytes = this.observations.estimatedBytes
        profile.totalMs = performance.now() - started
      }
      return observation
    }
    throw new Error('browser-observation-changed-during-capture')
  }

  private requireObservation(args: BrowserArgs): CachedBrowserObservation {
    const observation = typeof args.observationId === 'string' ? this.observations.get(args.observationId) : undefined
    if (!observation) throw new Error('browser-observation-required')
    if (observation.documentId !== this.documentId) throw new Error('stale-browser-observation')
    return observation
  }

  /** The call's observation; without one (a CLI call), the latest AX
   *  observation of this document, taken now if there is none. */
  private async baseline(args: BrowserArgs): Promise<CachedBrowserObservation> {
    // Ids and points belong to their observation's document; a call without
    // them (a key, text, a text wait) may follow the page wherever it went.
    const targeted = args.target !== undefined || args.from !== undefined || args.element !== undefined
    const named = typeof args.observationId === 'string' ? this.observations.get(args.observationId) : undefined
    if (args.observationId !== undefined && (targeted || named?.documentId === this.documentId)) return this.requireObservation(args)
    const latest = this.latestAx ? this.observations.get(this.latestAx) : undefined
    if (latest && latest.documentId === this.documentId) return latest
    return this.requireObservation({ observationId: (await this.observe()).observationId })
  }

  private element(id: unknown, observation: CachedBrowserObservation): ElementTarget {
    if (id === undefined) throw new Error('browser-target-required')
    if (observation.kind !== 'ax') throw new Error('browser-ax-observation-required')
    // Ids stay the same for an element while its document lives, so any id
    // this driver issued for the current document will do.
    if (!Number.isSafeInteger(id) || (id as number) < 1 || (id as number) > this.elementCounter) throw new Error('browser-unknown-element')
    const ref = this.refs.get(id as number)
    if (!ref || ref.documentEpoch !== this.documentEpoch) throw new Error('stale-browser-element')
    return { backendNodeId: ref.backendNodeId, frameId: ref.frameId, sessionId: ref.sessionId }
  }

  private async point(raw: unknown, observation: CachedBrowserObservation): Promise<[number, number]> {
    if (!Array.isArray(raw) || raw.length !== 2 || !raw.every(value => typeof value === 'number' && Number.isFinite(value))) throw new Error('browser-point-required')
    const viewport = await this.viewport()
    if (observation.documentId !== this.documentId) throw new Error('stale-browser-observation')
    if (!this.sameViewport(observation.viewport, viewport)) throw new Error('stale-browser-coordinates')
    const [x, y] = raw as [number, number]
    if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) throw new Error('browser-point-outside-viewport')
    return [x, y]
  }

  private async activeElement(observation: CachedBrowserObservation): Promise<ElementTarget> {
    if (observation.kind !== 'ax') throw new Error('browser-ax-observation-required')
    // Focus can move between cells, including into frames and closed shadows.
    const fresh = await this.observe()
    if (fresh.documentId !== observation.documentId) throw new Error('stale-browser-observation')
    observation = this.requireObservation({ observationId: fresh.observationId })
    if (observation.focusedElementId !== undefined) return this.element(observation.focusedElementId, observation)
    const active = objectValue((await this.send('Runtime.evaluate', { expression: 'document.activeElement', returnByValue: false, objectGroup: 'cate-browser' })).result)
    if (typeof active.objectId !== 'string') throw new Error('browser-focused-element-required')
    const described = await this.send('DOM.describeNode', { objectId: active.objectId })
    const backendNodeId = objectValue(described.node).backendNodeId
    if (typeof backendNodeId !== 'number') throw new Error('browser-focused-element-required')
    return { objectId: active.objectId, backendNodeId }
  }

  private async waitCondition(args: BrowserArgs, observation: CachedBrowserObservation): Promise<void> {
    const condition = { text: args.text, url: args.url, element: args.element, state: args.state, locator: browserLocatorOf(args) }
    const keys = ['text', 'url', 'element', 'locator'].filter(key => condition[key as keyof typeof condition] !== undefined)
    if (keys.length !== 1) throw new Error('browser-wait-requires-one-condition')
    const state = condition.state ?? 'visible'
    if (!['visible', 'hidden', 'checked', 'unchecked', 'enabled', 'disabled'].includes(String(state))) throw new Error('unsupported-browser-wait-state')
    const timeout = args.timeoutMs === undefined ? 5000 : Number(args.timeoutMs)
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > BROWSER_WAIT_MAX_MS) throw new Error('invalid-browser-timeout')
    const deadline = Date.now() + timeout
    for (;;) {
      this.check()
      if (observation.documentId !== this.documentId && condition.element !== undefined) throw new Error('stale-browser-observation')
      let ready = false
      // Only the answer crosses CDP, not the page's text every 50 ms.
      if (typeof condition.text === 'string') ready = await this.evaluate(`(document.body?.innerText ?? "").includes(${JSON.stringify(condition.text)})`) === true
      else if (typeof condition.url === 'string') ready = globMatches(this.contents.getURL(), condition.url)
      else if (condition.locator) ready = this.locatedState(condition.locator, (await this.observe()).elements, String(state))
      else if (condition.element !== undefined) {
        try {
          const target = this.element(condition.element, observation)
          const result = objectValue((await this.callOn(target, `function () {
            return { visible:this.isConnected && this.checkVisibility({opacityProperty:true,visibilityProperty:true}) && Array.from(this.getClientRects()).some(r=>r.width>0&&r.height>0), checked:Boolean(this.checked), enabled:!this.matches(':disabled') && !this.closest('[aria-disabled="true"],[inert]') };
          }`)).value)
          ready = state === 'visible' ? result.visible === true : state === 'hidden' ? result.visible !== true : state === 'checked' ? result.checked === true : state === 'unchecked' ? result.checked === false : state === 'enabled' ? result.enabled === true : result.enabled === false
        } catch (error) {
          this.check()
          if (state === 'hidden' && error instanceof Error && !['browser-unknown-element', 'stale-browser-observation'].includes(error.message)) ready = true
          else throw error
        }
      } else throw new Error('invalid-browser-wait-condition')
      this.check()
      if (ready) return
      if (Date.now() >= deadline) throw new Error('browser-wait-timeout')
      // A locator reads the whole tree; the other conditions are cheap.
      await new Promise(resolve => setTimeout(resolve, condition.locator ? LOCATOR_POLL_MS : 50))
    }
  }

  /** Whether the element `locator` finds is in `state`; `hidden` holds when none matches. */
  private locatedState(locator: BrowserLocator, elements: BrowserElement[], state: string): boolean {
    const matches = matchBrowserElements(elements, locator)
    if (state === 'visible' || state === 'hidden') return (matches.length > 0) === (state === 'visible')
    if (matches.length === 0) return false
    if (matches.length > 1) throw ambiguous(locator, matches)
    const states = matches[0].states ?? {}
    const on = (key: string) => states[key] === true || states[key] === 'true'
    if (state === 'checked' || state === 'unchecked') return on('checked') === (state === 'checked')
    return on('disabled') === (state === 'disabled')
  }

  /** The one element of a fresh snapshot `locator` matches, waiting up to
   *  `timeoutMs` for it to appear; the action then diffs against that snapshot. */
  private async locateElement(locator: BrowserLocator, timeoutMs = ACTIONABLE_TIMEOUT_MS): Promise<{ id: number; observation: CachedBrowserObservation }> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      this.check()
      const fresh = await this.observe()
      const matches = matchBrowserElements(fresh.elements, locator)
      if (matches.length === 1) return { id: matches[0].id, observation: this.requireObservation({ observationId: fresh.observationId }) }
      if (matches.length > 1) throw ambiguous(locator, matches)
      if (Date.now() >= deadline) throw new Error(`browser-no-matching-element: nothing on the page matches ${describeBrowserLocator(locator)}`)
      await sleep(LOCATOR_POLL_MS)
    }
  }

  private async executeBound(method: string, args: BrowserArgs): Promise<BrowserDriverResult> {
    if (BROWSER_OBSERVATION_METHODS.has(method)) return { result: await this.observe(args, method !== 'getAXState', method === 'getScreenshot') }
    if (BROWSER_LOG_METHODS.has(method)) return { result: this.log.read(method, args) }
    if (method === 'find') {
      const locator = browserLocatorOf(args)
      if (!locator) throw new Error('browser-locator-required')
      const { url, title, elements } = await this.observe()
      return { result: { url, title, elements: matchBrowserElements(elements, locator) } }
    }
    if (!BROWSER_ELEMENT_READ_METHODS.has(method) && !BROWSER_ACTION_METHODS.has(method) && method !== 'waitFor') throw new Error('unsupported-browser-method')
    // A click or a key can open a file chooser: the agent answers it with
    // `upload`, so the chooser is reported rather than shown.
    const choosing = method === 'click' || method === 'pressKey'
    if (!choosing) return this.runAction(method, args)
    this.fileChooser = undefined
    await this.interceptFileChooser(true)
    try {
      const outcome = await this.runAction(method, args)
      if (!this.fileChooser) return outcome
      const result = objectValue(outcome.result)
      const action = objectValue(result.action) as unknown as BrowserActionOutcome
      const notice = 'The action opened a file chooser. Answer it with cate browser upload chooser <file>...'
      return { ...outcome, result: { ...result, action: { ...action, notices: [...(action.notices ?? []), notice] } } }
    } finally {
      await this.interceptFileChooser(false)
    }
  }

  private async runAction(method: string, args: BrowserArgs): Promise<BrowserDriverResult> {
    let observation = await this.baseline(args)
    // `--role`/`--name` name the target instead of an id; a wait polls for it itself.
    const locator = method === 'waitFor' ? undefined : browserLocatorOf(args)
    if (locator) {
      if (args.target !== undefined && args.target !== null) throw new Error('browser-target-or-locator')
      const timeout = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined
      const located = await this.locateElement(locator, timeout)
      observation = located.observation
      args = { ...args, target: located.id }
    }
    const epoch = this.documentEpoch
    const startedAt = Date.now()
    const url = this.contents.getURL()
    if (method === 'getAttribute') {
      if (typeof args.attribute !== 'string' || !args.attribute) throw new Error('browser-attribute-name-required')
      const result = objectValue((await this.callOn(this.element(args.target, observation), `function () {
        if (!(this instanceof Element)) return { element:false };
        return { element:true, value:this.getAttribute(${JSON.stringify(args.attribute)}) };
      }`)).value)
      if (result.element !== true) throw new Error('browser-attribute-target-required')
      return { result: typeof result.value === 'string' ? result.value : null }
    }
    let verified = false
    let cursor: BrowserDriverResult['cursor']
    const notices: string[] = []
    let uploaded: string[] | undefined
    if (method === 'waitFor') {
      await this.waitCondition(args, observation)
      verified = true
    } else if (method === 'click') {
      const count = args.clickCount === undefined ? 1 : args.clickCount
      const button = args.mouseButton ?? 'left'
      if (![1, 2, 3].includes(Number(count)) || !['left', 'middle', 'right'].includes(String(button))) throw new Error('invalid-browser-click-options')
      if (Array.isArray(args.target)) {
        const [x, y] = await this.point(args.target, observation)
        await this.dispatchInput({ type: 'mouseMoved', x, y }); this.check()
        try { await this.dispatchInput({ type: 'mousePressed', x, y, button, clickCount: count }) }
        finally { await this.dispatchInput({ type: 'mouseReleased', x, y, button, clickCount: count }) }
        cursor = { x, y, label: 'click', kind: 'click' }
      } else {
        const timeout = args.timeoutMs === undefined ? undefined : Number(args.timeoutMs)
        if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0 || timeout > BROWSER_WAIT_MAX_MS)) throw new Error('invalid-browser-timeout')
        cursor = await this.clickElement(this.element(args.target, observation), Number(count), String(button), timeout)
      }
    } else if (method === 'hover') {
      let x: number, y: number
      if (Array.isArray(args.target)) [x, y] = await this.point(args.target, observation)
      else {
        const box = await this.actionableBox(await this.pointerTarget(this.element(args.target, observation)))
        x = box.x + box.width / 2; y = box.y + box.height / 2
      }
      await this.dispatchInput({ type: 'mouseMoved', x, y })
      cursor = { x, y, label: 'hover', kind: 'hover' }
    } else if (method === 'setValue' || method === 'typeText') {
      const text = method === 'setValue' ? args.value : args.text
      if (typeof text !== 'string') throw new Error('browser-text-required')
      const focused = args.target === undefined && method === 'typeText'
      const target = focused ? await this.activeElement(observation) : this.element(args.target, observation)
      if (focused) await this.assertEditable(target).catch((error) => { throw error instanceof Error && error.message === 'element-not-editable' ? new Error('browser-type-target-not-focused') : error })
      if (method === 'setValue') { await this.fillElement(target, text); verified = true }
      else await this.typeElement(target, text)
      // Measure after editing so focus/scroll/layout changes are reflected.
      // A removed field must not turn a successful edit into a feedback error.
      const box = await this.box(target, false).catch(() => undefined)
      if (box) cursor = this.cursor(box, method, 'type')
    } else if (method === 'pressKey') {
      if (typeof args.key !== 'string') throw new Error('browser-key-required')
      if (args.target !== undefined) await this.focusElement(this.element(args.target, observation))
      await this.pressKey(args.key)
    } else if (method === 'setChecked') {
      if (typeof args.checked !== 'boolean') throw new Error('browser-checked-required')
      const target = this.element(args.target, observation)
      const checked = (await this.callOn(target, 'function () { return typeof this.checked === "boolean" ? this.checked : null; }')).value
      if (typeof checked !== 'boolean') throw new Error('browser-checkbox-required')
      if (checked !== args.checked) cursor = await this.clickElement(target, 1, 'left')
      if ((await this.callOn(target, 'function () { return Boolean(this.checked); }')).value !== args.checked) throw new Error('browser-check-postcondition-failed')
      verified = true
    } else if (method === 'selectOption') {
      const values = typeof args.values === 'string' ? [args.values] : args.values
      if (!Array.isArray(values) || !values.every(value => typeof value === 'string')) throw new Error('browser-option-values-required')
      const target = this.element(args.target, observation)
      const result = await this.callOn(target, `function () {
        if(!(this instanceof HTMLSelectElement)) return 'browser-select-required';
        if(this.matches(':disabled')) return 'element-disabled';
        const values=${JSON.stringify(values)};
        if(!this.multiple && values.length!==1) return 'browser-single-select-requires-one-value';
        if(values.some(value=>!Array.from(this.options).some(option=>option.value===value && !option.disabled))) return 'browser-option-not-found';
        for(const option of this.options) option.selected=values.includes(option.value);
        this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));
        return Array.from(this.selectedOptions).map(option=>option.value).sort().join('\\0')===values.slice().sort().join('\\0');
      }`)
      // A string is a check that failed before any option changed.
      this.inputSent = typeof result.value !== 'string'
      if (result.value !== true) throw new Error(typeof result.value === 'string' ? result.value : 'browser-select-postcondition-failed')
      verified = true
    } else if (method === 'upload') {
      const files = args.files
      if (!Array.isArray(files) || !files.length || !files.every(file => typeof file === 'string' && file)) throw new Error('browser-upload-file-required')
      if (args.drop === true) {
        if (args.target === undefined || args.target === null) throw new Error('browser-drop-target-required')
        let x: number, y: number
        if (Array.isArray(args.target)) [x, y] = await this.point(args.target, observation)
        else { const box = await this.box(this.element(args.target, observation)); x = box.x + box.width / 2; y = box.y + box.height / 2 }
        await this.dropFiles(x, y, files)
        cursor = { x, y, label: 'drop', kind: 'drag' }
      } else {
        uploaded = await this.uploadFiles(args.target === undefined || args.target === null ? undefined : this.element(args.target, observation), files)
        verified = true
      }
    } else if (method === 'login') {
      const credential = objectValue(args.credential)
      if (typeof credential.username !== 'string' || typeof credential.password !== 'string' || !credential.password || typeof credential.origin !== 'string') {
        throw new Error('browser-login-credential-required')
      }
      const target = args.target === undefined || args.target === null ? undefined : this.element(args.target, observation)
      notices.push(...await this.login(target, { username: credential.username, password: credential.password, origin: credential.origin }))
      verified = true
    } else if (method === 'scroll') {
      const direction = args.direction ?? 'down'
      const pages = args.pages ?? 1
      if (!['up', 'down', 'left', 'right'].includes(String(direction)) || typeof pages !== 'number' || !Number.isFinite(pages) || pages <= 0 || pages > 100) throw new Error('invalid-browser-scroll')
      const viewport = await this.viewport()
      let x: number, y: number
      if (Array.isArray(args.target)) [x, y] = await this.point(args.target, observation)
      else if (args.target === undefined) [x, y] = [viewport.width / 2, viewport.height / 2]
      else { const box = await this.box(this.element(args.target, observation)); x = box.x + box.width / 2; y = box.y + box.height / 2 }
      const vertical = direction === 'up' || direction === 'down'
      const amount = (vertical ? viewport.height : viewport.width) * pages * (direction === 'up' || direction === 'left' ? -1 : 1)
      await this.dispatchInput({ type: 'mouseWheel', x, y, deltaX: vertical ? 0 : amount, deltaY: vertical ? amount : 0 })
      cursor = { x, y, label: 'scroll', kind: 'scroll' }
    } else if (method === 'drag') {
      const from = await this.point(args.from, observation), to = await this.point(args.to, observation)
      await this.dispatchInput({ type: 'mouseMoved', x: from[0], y: from[1] }); this.check()
      try {
        await this.dispatchInput({ type: 'mousePressed', x: from[0], y: from[1], button: 'left', clickCount: 1 })
        for (let step = 1; step <= 10; step++) {
          this.check()
          await this.dispatchInput({ type: 'mouseMoved', x: from[0] + (to[0] - from[0]) * step / 10, y: from[1] + (to[1] - from[1]) * step / 10, button: 'left', buttons: 1 })
        }
      } finally { await this.dispatchInput({ type: 'mouseReleased', x: to[0], y: to[1], button: 'left', clickCount: 1 }) }
      cursor = { x: to[0], y: to[1], label: 'drag', kind: 'drag' }
    } else if (method === 'selectText') {
      if (typeof args.text !== 'string') throw new Error('browser-text-required')
      if ((args.prefix !== undefined && typeof args.prefix !== 'string') || (args.suffix !== undefined && typeof args.suffix !== 'string')) throw new Error('invalid-browser-selection-context')
      if (args.cursor !== undefined && args.cursor !== 'before' && args.cursor !== 'after') throw new Error('invalid-browser-selection-cursor')
      const selectionType = args.cursor === undefined ? 'text' : `cursor_${args.cursor}`
      const target = this.element(args.target, observation)
      await this.focusElement(target)
      const result = await this.callOn(target, `function () {
        const text=${JSON.stringify(args.text)}, mode=${JSON.stringify(selectionType)}, prefix=${JSON.stringify(args.prefix ?? '')}, suffix=${JSON.stringify(args.suffix ?? '')};
        const find=(content)=>{
          const matches=[];
          for(let at=content.indexOf(text);at>=0;at=content.indexOf(text,at+1)) {
            if((!prefix || content.slice(0,at).endsWith(prefix)) && (!suffix || content.slice(at+text.length).startsWith(suffix))) matches.push(at);
            if(at===content.length)break;
          }
          return matches.length===1 ? matches[0] : matches.length ? 'browser-selection-ambiguous' : 'browser-selection-text-not-found';
        };
        if(this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
          const start=find(this.value); if(typeof start!=='number')return start;
          const end=start+text.length;
          this.setSelectionRange(mode==='cursor_after'?end:start,mode==='cursor_before'?start:end); return true;
        }
        const walker=this.ownerDocument.createTreeWalker(this,NodeFilter.SHOW_TEXT),nodes=[];let node,content='';
        while(node=walker.nextNode()){nodes.push({node,start:content.length});content+=node.textContent;}
        const start=find(content);if(typeof start!=='number')return start;const end=start+text.length;
        const boundary=(at)=>{const match=nodes.find(item=>at<=item.start+item.node.textContent.length);return match?[match.node,at-match.start]:[this,0];};
        const range=this.ownerDocument.createRange();range.setStart(...boundary(mode==='cursor_after'?end:start));range.setEnd(...boundary(mode==='cursor_before'?start:end));
        const selection=this.ownerDocument.getSelection();selection.removeAllRanges();selection.addRange(range);return true;
      }`)
      if (result.value !== true) throw new Error(typeof result.value === 'string' ? result.value : 'browser-selection-text-not-found')
      verified = true
    }
    this.check()
    if (method !== 'waitFor') await this.settle(epoch, startedAt, url)
    const fresh = await this.observe({ observationId: observation.observationId })
    const action: BrowserActionOutcome = { method, status: verified ? 'verified' : 'dispatched', ...(notices.length ? { notices } : {}) }
    return { result: { action, observation: fresh, ...(uploaded ? { files: uploaded } : {}) }, ...(cursor ? { cursor } : {}) }
  }

}

/** Drives one guest. Attach before the first `execute`. */
export function createPageDriver(contents: WebContents, identity: BrowserPageIdentity, options: PageDriverOptions = {}): PageDriver {
  return new PageDriver(contents, identity, options)
}

/** The page drivers of every guest this process hosts, keyed by webContents id. */
export class PageDriverRegistry {
  private drivers = new Map<number, PageDriver>()

  constructor(private readonly options: PageDriverOptions = {}) {}

  async attach(contents: WebContents, identity: BrowserPageIdentity): Promise<void> {
    const existing = this.drivers.get(contents.id)
    if (existing) {
      existing.updateIdentity(identity)
      await existing.attach()
      return
    }
    const driver = createPageDriver(contents, identity, this.options)
    this.drivers.set(contents.id, driver)
    contents.once('destroyed', () => this.drivers.delete(contents.id))
    // A page blocked on a dialog answers no CDP command until it is answered.
    if (this.options.dialogs?.current(contents.id)) void driver.attach().catch(() => {})
    else await driver.attach()
  }

  noteUserInput(webContentsId: number): void {
    this.drivers.get(webContentsId)?.noteUserInput()
  }

  /** Restarts the guest's page when it stopped responding (`PageDriver.restartIfHung`). */
  async restartIfHung(webContentsId: number): Promise<boolean> {
    return await this.drivers.get(webContentsId)?.restartIfHung() ?? false
  }

  isRegistered(webContentsId: number): boolean {
    return this.drivers.has(webContentsId)
  }

  async execute(webContentsId: number, identity: BrowserPageIdentity, method: string, args: BrowserArgs): Promise<BrowserDriverResult> {
    const driver = this.drivers.get(webContentsId)
    if (!driver || !driver.matches(identity)) return { error: 'browser-target-not-registered' }
    return driver.execute(method, args)
  }

  async fillCredential(webContentsId: number, targetId: string, credential: { username: string; password: string }): Promise<{ ok?: true; error?: string }> {
    const driver = this.drivers.get(webContentsId)
    return driver ? driver.fillCredential(targetId, credential) : { error: 'browser-target-not-registered' }
  }
}
