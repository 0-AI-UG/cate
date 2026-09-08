import { type WebContents } from 'electron'
import { BROWSER_ACTION_METHODS, BROWSER_OBSERVATION_METHODS, type BrowserObservation, type BrowserObservationPerformance, type BrowserElement, type BrowserViewportState, type BrowserImage } from '../../shared/browserAutomation'
import { BrowserObservationCache, type CachedBrowserObservation } from './browserObservationCache'
import { readBrowserAX } from './browserAX'

type BrowserArgs = Record<string, unknown>

export interface BrowserTargetIdentity {
  workspaceId: string
  panelId: string
  tabId: string
}

export interface BrowserRuntimeResult {
  result?: unknown
  cursor?: {
    x?: number
    y?: number
    rect?: [number, number, number, number]
    label: string
    kind: 'move' | 'click' | 'dblclick' | 'hover' | 'drag' | 'scroll' | 'type' | 'press'
  }
  error?: string
  recovery?: string
  observation?: BrowserObservation
}

type CursorKind = NonNullable<BrowserRuntimeResult['cursor']>['kind']

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

interface CdpEvent {
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

const KEY_DATA: Record<string, { key: string; code: string; windowsVirtualKeyCode: number; nativeVirtualKeyCode: number; text?: string; unmodifiedText?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, text: ' ', unmodifiedText: ' ' },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33, nativeVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34, nativeVirtualKeyCode: 34 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35 },
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function globMatches(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')
  return new RegExp(`^${escaped}$`).test(value)
}

class BrowserTargetRuntime {
  readonly contents: WebContents
  identity: BrowserTargetIdentity
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
  private frameParents = new Map<string, string | undefined>()
  private frameSessions = new Map<string, string>()
  private sessionFrames = new Map<string, string>()
  private attached = false
  private readonly onDebuggerMessage = (_event: Electron.Event, method: string, params: unknown, sessionId?: string): void => {
    this.handleEvent({ method, params: objectValue(params), sessionId })
  }

  constructor(contents: WebContents, identity: BrowserTargetIdentity) {
    this.contents = contents
    this.identity = identity
    contents.once('destroyed', () => this.dispose())
  }

  matches(identity: BrowserTargetIdentity): boolean {
    return this.identity.workspaceId === identity.workspaceId
      && this.identity.panelId === identity.panelId
      && this.identity.tabId === identity.tabId
  }

  updateIdentity(identity: BrowserTargetIdentity): void {
    this.identity = identity
  }

  noteUserInput(): void {
    if (this.agentInputDepth === 0) this.userInputEpoch += 1
  }

  async attach(): Promise<void> {
    if (this.attached || this.contents.isDestroyed()) return
    if (!this.contents.debugger.isAttached()) this.contents.debugger.attach('1.3')
    this.contents.debugger.on('message', this.onDebuggerMessage)
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
      ])
    } catch (error) {
      this.attached = false
      this.contents.debugger.removeListener('message', this.onDebuggerMessage)
      throw error
    }
  }

  dispose(): void {
    this.refs.clear()
    this.stableIds.clear()
    this.observations.clear()
    this.frameParents.clear()
    this.frameSessions.clear()
    this.sessionFrames.clear()
    if (!this.contents.isDestroyed()) {
      this.contents.debugger.removeListener('message', this.onDebuggerMessage)
      if (this.contents.debugger.isAttached()) {
        try { this.contents.debugger.detach() } catch { /* target already gone */ }
      }
    }
    this.attached = false
  }

  execute(method: string, args: BrowserArgs): Promise<BrowserRuntimeResult> {
    return this.enqueue(() => this.executeBound(method, args)).catch((error) => ({ error: error instanceof Error ? error.message : 'browser-command-failed', recovery: 'Observe the bound tab again before retrying; input may already have been dispatched.' }))
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
          await Promise.allSettled([undefined, ...this.sessionFrames.keys()].map(async sessionId => {
            await this.contents.debugger.sendCommand('Runtime.releaseObjectGroup', { objectGroup: 'cate-browser' }, sessionId)
          }))
        }
        this.activeGuard = undefined
      }
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  async fillCredential(targetId: string, credential: { username: string; password: string }): Promise<{ ok?: true; error?: string }> {
    return this.enqueue(() => this.executeExclusive(async (guard) => {
      const selector = `[data-cate-autofill-target=${JSON.stringify(targetId)}]`
      const password = await this.resolveSelector(selector)
      const usernameResult = await this.callOn(password, `function () {
        const visible = (element) => {
          const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
          return !element.disabled && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const scope = this.form || document.body;
        return Array.from(scope.querySelectorAll('input[autocomplete="username"],input[autocomplete="email"],input[type="email"],input[type="text"]')).filter(visible).at(-1) || null;
      }`, false)
      guard()
      if (typeof usernameResult.objectId === 'string') {
        const usernameObjectId = usernameResult.objectId
        const described = objectValue(await this.send('DOM.describeNode', { objectId: usernameObjectId }))
        const node = objectValue(described.node)
        if (typeof node.backendNodeId === 'number') {
          await this.fillElement({ objectId: usernameObjectId, backendNodeId: node.backendNodeId }, credential.username, guard)
        }
      }
      await this.fillElement(password, credential.password, guard)
      return { ok: true as const }
    })).catch((error) => ({ error: error instanceof Error ? error.message : 'credential-fill-failed' }))
  }

  private handleEvent(event: CdpEvent): void {
    if (event.method === 'Target.attachedToTarget') {
      const targetInfo = objectValue(event.params.targetInfo)
      const sessionId = typeof event.params.sessionId === 'string' ? event.params.sessionId : undefined
      const frameId = typeof targetInfo.targetId === 'string' ? targetInfo.targetId : undefined
      if (targetInfo.type === 'iframe' && sessionId && frameId) {
        this.frameSessions.set(frameId, sessionId)
        this.sessionFrames.set(sessionId, frameId)
        void this.enableSession(sessionId)
      }
      return
    }
    if (event.method === 'Target.detachedFromTarget') {
      const sessionId = typeof event.params.sessionId === 'string' ? event.params.sessionId : undefined
      if (sessionId) this.dropFrameSession(sessionId)
      return
    }
    if (event.method === 'Page.frameAttached') {
      const frameId = typeof event.params.frameId === 'string' ? event.params.frameId : undefined
      const parentFrameId = typeof event.params.parentFrameId === 'string' ? event.params.parentFrameId : undefined
      if (frameId) this.frameParents.set(frameId, parentFrameId)
      return
    }
    if (event.method === 'Page.frameDetached') {
      const frameId = typeof event.params.frameId === 'string' ? event.params.frameId : undefined
      if (frameId) this.dropFrame(frameId)
      return
    }
    if (event.method === 'Page.frameNavigated') {
      const frame = objectValue(event.params.frame)
      const frameId = typeof frame.id === 'string' ? frame.id : this.sessionFrames.get(event.sessionId ?? '')
      const parentId = typeof frame.parentId === 'string' ? frame.parentId : this.frameParents.get(frameId ?? '')
      if (!event.sessionId && !parentId) {
        this.documentEpoch += 1
        this.refs.clear()
        this.stableIds.clear()
        this.frameParents.clear()
      } else if (frameId) {
        this.frameParents.set(frameId, parentId)
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
    this.dropRefsForFrame(frameId)
    const sessionId = this.frameSessions.get(frameId)
    if (sessionId) this.sessionFrames.delete(sessionId)
    this.frameSessions.delete(frameId)
    this.frameParents.delete(frameId)
  }

  private dropFrameSession(sessionId: string): void {
    const frameId = this.sessionFrames.get(sessionId)
    if (frameId) this.dropFrame(frameId)
    else {
      for (const [ref, target] of this.refs) if (target.sessionId === sessionId) { this.refs.delete(ref); this.stableIds.delete(`${sessionId}:${target.backendNodeId}`) }
    }
  }

  private async send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    await this.attach()
    // Always allow paired releases so takeover cannot leave a button/key held.
    // Session setup also runs from debugger events, independently of commands.
    const releasingInput = (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased')
      || (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp')
    if (!releasingInput && !method.endsWith('.enable') && method !== 'Target.setAutoAttach') this.activeGuard?.()
    try {
      return objectValue(await this.contents.debugger.sendCommand(method, params, sessionId))
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'CDP command failed'
      throw new Error(`${method}: ${detail}`)
    }
  }

  /** Dispatch trusted input to this guest while marking the resulting DOM
   * events as agent-originated for the tiny guest preload. Without the marker,
   * the user-preemption listener would cancel the action on its own click. */
  private async dispatchInput(params: Record<string, unknown>): Promise<void> {
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
        const sessionId = this.frameSessions.get(frameId)
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
        await this.contents.debugger.sendCommand('Runtime.callFunctionOn', {
          objectId: watch.objectId, functionDeclaration: 'function () { this.cancel(); }', returnByValue: true,
        }, watch.sessionId)
      }))
    }
  }

  private async dispatchKey(params: Record<string, unknown>): Promise<void> {
    this.agentInputDepth += 1
    this.contents.send('cate-browser-automation-input', true)
    try {
      await this.send('Input.dispatchKeyEvent', params)
    } finally {
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (!this.contents.isDestroyed()) this.contents.send('cate-browser-automation-input', false)
      this.agentInputDepth -= 1
    }
  }

  private async executeExclusive<T>(operation: (guard: () => void) => Promise<T>): Promise<T> {
    await this.attach()
    const guard = this.activeGuard!
    guard()
    const result = await operation(guard)
    guard()
    return result
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
    const exception = response.exceptionDetails
    if (exception) throw new Error('page-evaluation-failed')
    return objectValue(response.result)
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
      const parent = this.frameParents.get(current)
      if (!parent) break
      const parentSession = this.frameSessions.get(parent)
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

  private cursor(box: { x: number; y: number; width: number; height: number }, label: string, kind: CursorKind): NonNullable<BrowserRuntimeResult['cursor']> {
    return {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      rect: [box.x, box.y, box.width, box.height],
      label,
      kind,
    }
  }

  private async clickElement(target: ElementTarget, count = 1, button = 'left', guard: () => void): Promise<ReturnType<BrowserTargetRuntime['cursor']>> {
    const box = await this.box(target)
    await new Promise((resolve) => setTimeout(resolve, 50))
    guard()
    const settled = await this.box(target, false)
    if (Object.keys(box).some((key) => Math.abs(box[key as keyof typeof box] - settled[key as keyof typeof settled]) > 0.5)) {
      throw new Error('element-not-stable')
    }
    const actionable = await this.callOn(target, `function () {
      if (!this.isConnected || !this.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return 'element-not-visible';
      if (this.matches(':disabled') || this.closest('[aria-disabled="true"],[inert]')) return 'element-disabled';
      const rect=this.getBoundingClientRect(), x=rect.x+rect.width/2, y=rect.y+rect.height/2;
      if (rect.width<=0 || rect.height<=0) return 'element-has-no-actionable-box';
      for(let target=this;target;) {
        const root=target.getRootNode(), hit=root.elementFromPoint(x,y);
        if(!hit || (hit!==target && !target.contains(hit))) return 'element-obscured';
        target=root.host;
      }
      return true;
    }`)
    if (actionable.value !== true) throw new Error(typeof actionable.value === 'string' ? actionable.value : 'element-not-actionable')
    guard()
    const x = settled.x + settled.width / 2
    const y = settled.y + settled.height / 2
    await this.dispatchInput({ type: 'mouseMoved', x, y })
    guard()
    try {
      await this.dispatchInput({ type: 'mousePressed', x, y, button, clickCount: count })
    } finally {
      await this.dispatchInput({ type: 'mouseReleased', x, y, button, clickCount: count })
    }
    guard()
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

  private async focusElement(target: ElementTarget): Promise<void> {
    await this.send('DOM.focus', { backendNodeId: target.backendNodeId }, target.sessionId)
  }

  private async fillElement(target: ElementTarget, text: string, guard: () => void): Promise<void> {
    await this.assertEditable(target)
    await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: target.backendNodeId }, target.sessionId)
    // Focus stays inside this CDP target's document. It does not activate the
    // Electron window, so xterm/Monaco focus in the host remains untouched.
    await this.focusElement(target)
    guard()
    await this.callOn(target, `function () {
      const text=${JSON.stringify(text)};
      if (this.isContentEditable) {
        this.textContent=text;
        const range=this.ownerDocument.createRange();range.selectNodeContents(this);range.collapse(false);
        const selection=this.ownerDocument.getSelection();selection.removeAllRanges();selection.addRange(range);
      }
      else {
        const proto=this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;
        if (setter) setter.call(this,text); else this.value=text;
      }
      this.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
      this.dispatchEvent(new Event('change',{bubbles:true}));
    }`)
    guard()
    const observed = await this.callOn(target, 'function () { return "value" in this ? this.value : this.textContent; }')
    if (typeof observed.value === 'string' && observed.value !== text) throw new Error('browser-fill-postcondition-failed')
  }

  private async typeElement(target: ElementTarget | null, text: string, guard: () => void): Promise<void> {
    if (!target) throw new Error('type-target-required')
    await this.assertEditable(target)
    await this.focusElement(target)
    guard()
    // Chromium's editing command respects the document selection and undo stack
    // even when this guest is not the OS-focused widget.
    const inserted = await this.callOn(target, `function () {
      return this.ownerDocument.execCommand('insertText', false, ${JSON.stringify(text)});
    }`)
    if (inserted.value !== true && text !== '') throw new Error('browser-type-failed')
    guard()
  }

  private async uploadFile(target: ElementTarget, filePath: string, guard: () => void): Promise<string> {
    const input = await this.callOn(target, `function () {
      return { file: this instanceof HTMLInputElement && this.type === 'file', enabled: !this.disabled };
    }`)
    const state = objectValue(input.value)
    if (state.file !== true) throw new Error('browser-upload-target-must-be-file-input')
    if (state.enabled !== true) throw new Error('element-disabled')
    guard()
    await this.send('DOM.setFileInputFiles', { files: [filePath], backendNodeId: target.backendNodeId }, target.sessionId)
    guard()
    const observed = await this.callOn(target, `function () {
      const file=this.files?.[0]; return file ? { name:file.name, size:file.size, count:this.files.length } : null;
    }`)
    const file = objectValue(observed.value)
    if (file.count !== 1 || typeof file.name !== 'string') throw new Error('browser-upload-postcondition-failed')
    return file.name
  }

  private async pressKey(keySpec: string, guard: () => void): Promise<void> {
    const parts = keySpec.replace(/^cmd\+/i, 'Meta+').replace(/^Return$/, 'Enter').split('+')
    const keyName = parts.pop() || ''
    const data = KEY_DATA[keyName] ?? (keyName.length === 1
      ? {
          key: keyName,
          code: `Key${keyName.toUpperCase()}`,
          windowsVirtualKeyCode: keyName.toUpperCase().charCodeAt(0),
          nativeVirtualKeyCode: keyName.toUpperCase().charCodeAt(0),
          text: keyName,
          unmodifiedText: keyName,
        }
      : undefined)
    if (!data) throw new Error(`unsupported-key:${keyName}`)
    // Enter's default form behavior is scoped to the active element in this
    // target. Chromium suppresses that default when its native widget is not
    // the OS-focused view, so perform the equivalent inside the guest instead
    // of allowing the key to fall through to xterm/Monaco.
    if (keyName === 'Enter' && parts.length === 0) {
      guard()
      await this.evaluate(`(() => {
        const target=document.activeElement;
        if (!(target instanceof HTMLElement)) return false;
        const allowed=target.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,bubbles:true,cancelable:true}));
        if (allowed) {
          if (!target.matches(':disabled') && !target.closest('[inert],[aria-disabled="true"]')) {
            if (target instanceof HTMLTextAreaElement && !target.readOnly) document.execCommand('insertText',false,'\\n');
            else if (target.isContentEditable) document.execCommand('insertParagraph');
            else if (target instanceof HTMLButtonElement) target.click();
            else if (!(target instanceof HTMLTextAreaElement) && target.form) target.form.requestSubmit();
          }
        }
        target.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',keyCode:13,bubbles:true}));
        return true;
      })()`)
      return
    }
    if ((keyName === 'PageDown' || keyName === 'PageUp') && parts.length === 0) {
      guard()
      await this.evaluate(`scrollBy(0, ${keyName === 'PageDown' ? 'innerHeight' : '-innerHeight'}); true`)
      return
    }
    let modifiers = 0
    if (parts.includes('Alt')) modifiers |= 1
    if (parts.includes('Control') || parts.includes('Ctrl')) modifiers |= 2
    if (parts.includes('Meta')) modifiers |= 4
    if (parts.includes('Shift')) modifiers |= 8
    try {
      await this.dispatchKey({ type: 'rawKeyDown', ...data, modifiers })
    } finally {
      await this.dispatchKey({ type: 'keyUp', ...data, modifiers })
    }
    guard()
  }

  private recordFrameTree(raw: unknown, parentId: string | undefined, frameIds: string[]): void {
    const tree = objectValue(raw)
    const frame = objectValue(tree.frame)
    const frameId = typeof frame.id === 'string' ? frame.id : undefined
    if (!frameId) return
    this.frameParents.set(frameId, parentId)
    frameIds.push(frameId)
    if (Array.isArray(tree.childFrames)) {
      for (const child of tree.childFrames) this.recordFrameTree(child, frameId, frameIds)
    }
  }

  private async currentFrameIds(): Promise<string[]> {
    const response = await this.send('Page.getFrameTree')
    const frameIds: string[] = []
    this.recordFrameTree(response.frameTree, undefined, frameIds)
    return frameIds
  }

  private async readAXState(): Promise<{ state: string; elements: BrowserElement[] }> {
    const frameIds = await this.currentFrameIds()
    if (!frameIds.length) throw new Error('browser-frame-unavailable')
    const worlds = new Map<string, Promise<number>>()
    return readBrowserAX({
      frames: frameIds.map(frameId => ({ frameId, sessionId: this.frameSessions.get(frameId) })),
      send: (method, params, sessionId) => this.send(method, params, sessionId),
      callOn: async (target, declaration) => {
        const key = `${target.sessionId ?? 'root'}:${target.frameId}`
        let world = worlds.get(key)
        if (!world) {
          world = this.send('Page.createIsolatedWorld', { frameId: target.frameId, worldName: 'cate-browser-observation' }, target.sessionId).then(result => {
            if (typeof result.executionContextId !== 'number') throw new Error('browser-inspection-context-unavailable')
            return result.executionContextId
          })
          worlds.set(key, world)
        }
        return this.callOn(target, declaration, true, await world)
      },
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

  private async captureViewport(viewport: BrowserViewportState, profile?: BrowserObservationPerformance): Promise<BrowserImage> {
    // Layout/zoom values can update before Chromium submits their pixels.
    // One rAF runs before paint; the next gives that frame a chance to submit
    // before Electron immediately copies the current compositor surface.
    let started = performance.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))'),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('browser-render-frame-timeout')), 5000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
    if (profile) profile.frameWaitMs += performance.now() - started
    this.activeGuard?.()
    started = performance.now()
    const capture = await this.contents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    if (profile) profile.captureMs += performance.now() - started
    started = performance.now()
    const resized = capture.resize({ width: Math.round(viewport.width), height: Math.round(viewport.height) })
    if (profile) profile.resizeMs += performance.now() - started
    started = performance.now()
    const data = resized.toPNG()
    if (profile) { profile.pngMs += performance.now() - started; profile.imageBytes = data.length }
    started = performance.now()
    const encoded = data.toString('base64')
    if (profile) profile.base64Ms += performance.now() - started
    return { mimeType: 'image/png', data: encoded, width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
  }

  private async observe(args: BrowserArgs = {}, screenshot = false, imageOnly = false): Promise<BrowserObservation> {
    const started = performance.now()
    const profile: BrowserObservationPerformance | undefined = args.profile === true ? {
      axMs: 0, frameWaitMs: 0, captureMs: 0, resizeMs: 0, pngMs: 0, base64Ms: 0,
      totalMs: 0, imageBytes: 0, cacheEntries: 0, cacheEstimatedBytes: 0,
    } : undefined
    const baseline = typeof args.observationId === 'string' ? this.observations.get(args.observationId) : undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      const documentId = this.documentId
      const before = await this.viewport()
      const axStarted = performance.now()
      const ax = imageOnly ? { state: '', elements: [] } : await this.readAXState()
      if (profile && !imageOnly) profile.axMs += performance.now() - axStarted
      const image = screenshot ? await this.captureViewport(before, profile) : undefined
      const after = await this.viewport()
      if (documentId !== this.documentId || !this.sameViewport(before, after)) continue
      let state = ax.state
      const diff = !imageOnly && args.disableDiffing !== true && baseline?.kind === 'ax' && baseline.documentId === documentId
      if (diff) {
        const old = new Set(baseline.state.split('\n'))
        const current = new Set(state.split('\n'))
        const removed = [...old].filter(line => !current.has(line)).map(line => `- ${line}`)
        const added = [...current].filter(line => !old.has(line)).map(line => `+ ${line}`)
        state = [...removed, ...added].join('\n') || 'No changes.'
      }
      const observation: BrowserObservation = {
        kind: imageOnly ? 'image' : 'ax',
        panelId: this.identity.panelId, tabId: this.identity.tabId, observationId: `${documentId}:o${++this.observationCounter}`,
        documentId, url: this.contents.getURL(), title: this.contents.getTitle(), viewport: after,
        state, elements: ax.elements, diff: Boolean(diff), ...(image ? { screenshot: image } : {}), ...(profile ? { performance: profile } : {}),
      }
      this.observations.set(observation, ax.state)
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

  private element(id: unknown, observation: CachedBrowserObservation): ElementTarget {
    if (observation.kind !== 'ax') throw new Error('browser-ax-observation-required')
    if (!Number.isSafeInteger(id) || !observation.elementIds.has(id as number)) throw new Error('browser-element-not-in-observation')
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
    if (observation.focusedElementId !== undefined) return this.element(observation.focusedElementId, observation)
    const active = objectValue((await this.send('Runtime.evaluate', { expression: 'document.activeElement', returnByValue: false, objectGroup: 'cate-browser' })).result)
    if (typeof active.objectId !== 'string') throw new Error('browser-focused-element-required')
    const described = await this.send('DOM.describeNode', { objectId: active.objectId })
    const backendNodeId = objectValue(described.node).backendNodeId
    if (typeof backendNodeId !== 'number') throw new Error('browser-focused-element-required')
    return { objectId: active.objectId, backendNodeId }
  }

  private async waitCondition(args: BrowserArgs, observation: CachedBrowserObservation): Promise<void> {
    const condition = objectValue(args.condition)
    const keys = ['text', 'url', 'element'].filter(key => condition[key] !== undefined)
    if (keys.length !== 1) throw new Error('browser-wait-requires-one-condition')
    const timeout = args.timeoutMs === undefined ? 5000 : Number(args.timeoutMs)
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 30000) throw new Error('invalid-browser-timeout')
    const deadline = Date.now() + timeout
    for (;;) {
      this.activeGuard?.()
      if (observation.documentId !== this.documentId && condition.element !== undefined) throw new Error('stale-browser-observation')
      let ready = false
      if (typeof condition.text === 'string') ready = String(await this.evaluate('document.body?.innerText ?? ""')).includes(condition.text)
      else if (typeof condition.url === 'string') ready = globMatches(this.contents.getURL(), condition.url)
      else if (condition.element !== undefined) {
        const state = condition.state ?? 'visible'
        if (!['visible', 'hidden', 'checked', 'unchecked', 'enabled', 'disabled'].includes(String(state))) throw new Error('unsupported-browser-wait-state')
        try {
          const target = this.element(condition.element, observation)
          const result = objectValue((await this.callOn(target, `function () {
            return { visible:this.isConnected && this.checkVisibility({opacityProperty:true,visibilityProperty:true}) && Array.from(this.getClientRects()).some(r=>r.width>0&&r.height>0), checked:Boolean(this.checked), enabled:!this.matches(':disabled') && !this.closest('[aria-disabled="true"],[inert]') };
          }`)).value)
          ready = state === 'visible' ? result.visible === true : state === 'hidden' ? result.visible !== true : state === 'checked' ? result.checked === true : state === 'unchecked' ? result.checked === false : state === 'enabled' ? result.enabled === true : result.enabled === false
        } catch (error) {
          this.activeGuard?.()
          if (state === 'hidden' && error instanceof Error && !['browser-element-not-in-observation', 'stale-browser-observation'].includes(error.message)) ready = true
          else throw error
        }
      } else throw new Error('invalid-browser-wait-condition')
      this.activeGuard?.()
      if (ready) return
      if (Date.now() >= deadline) throw new Error('browser-wait-timeout')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  private async executeBound(method: string, args: BrowserArgs): Promise<BrowserRuntimeResult> {
    if (BROWSER_OBSERVATION_METHODS.has(method)) return { result: await this.observe(args, method !== 'getAXState', method === 'getScreenshot') }
    if (!BROWSER_ACTION_METHODS.has(method) && method !== 'waitFor') throw new Error('unsupported-browser-method')
    const observation = this.requireObservation(args)
    const guard = this.activeGuard!
    let verified = false
    let cursor: BrowserRuntimeResult['cursor']
    if (method === 'waitFor') {
      await this.waitCondition(args, observation)
      verified = true
    } else if (method === 'click') {
      const count = args.clickCount === undefined ? 1 : args.clickCount
      const button = args.mouseButton ?? 'left'
      if (![1, 2, 3].includes(Number(count)) || !['left', 'middle', 'right'].includes(String(button))) throw new Error('invalid-browser-click-options')
      if (Array.isArray(args.target)) {
        const [x, y] = await this.point(args.target, observation)
        await this.dispatchInput({ type: 'mouseMoved', x, y }); guard()
        try { await this.dispatchInput({ type: 'mousePressed', x, y, button, clickCount: count }) }
        finally { await this.dispatchInput({ type: 'mouseReleased', x, y, button, clickCount: count }) }
        cursor = { x, y, label: 'click', kind: 'click' }
      } else cursor = await this.clickElement(this.element(args.target, observation), Number(count), String(button), guard)
    } else if (method === 'setValue' || method === 'typeText') {
      const text = method === 'setValue' ? args.value : args.text
      if (typeof text !== 'string') throw new Error('browser-text-required')
      const target = args.target === undefined && method === 'typeText' ? await this.activeElement(observation) : this.element(args.target, observation)
      if (method === 'setValue') { await this.fillElement(target, text, guard); verified = true }
      else await this.typeElement(target, text, guard)
    } else if (method === 'pressKey') {
      if (typeof args.key !== 'string') throw new Error('browser-key-required')
      if (args.target !== undefined) await this.focusElement(this.element(args.target, observation))
      await this.pressKey(args.key, guard)
    } else if (method === 'setChecked') {
      if (typeof args.checked !== 'boolean') throw new Error('browser-checked-required')
      const target = this.element(args.target, observation)
      const checked = (await this.callOn(target, 'function () { return typeof this.checked === "boolean" ? this.checked : null; }')).value
      if (typeof checked !== 'boolean') throw new Error('browser-checkbox-required')
      if (checked !== args.checked) cursor = await this.clickElement(target, 1, 'left', guard)
      if ((await this.callOn(target, 'function () { return Boolean(this.checked); }')).value !== args.checked) throw new Error('browser-check-postcondition-failed')
      verified = true
    } else if (method === 'selectOption') {
      if (!Array.isArray(args.values) || !args.values.every(value => typeof value === 'string')) throw new Error('browser-option-values-required')
      const target = this.element(args.target, observation)
      const result = await this.callOn(target, `function () {
        if(!(this instanceof HTMLSelectElement)) return 'browser-select-required';
        if(this.matches(':disabled')) return 'element-disabled';
        const values=${JSON.stringify(args.values)};
        if(!this.multiple && values.length!==1) return 'browser-single-select-requires-one-value';
        if(values.some(value=>!Array.from(this.options).some(option=>option.value===value && !option.disabled))) return 'browser-option-not-found';
        for(const option of this.options) option.selected=values.includes(option.value);
        this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));
        return Array.from(this.selectedOptions).map(option=>option.value).sort().join('\\0')===values.slice().sort().join('\\0');
      }`)
      if (result.value !== true) throw new Error(typeof result.value === 'string' ? result.value : 'browser-select-postcondition-failed')
      verified = true
    } else if (method === 'upload') {
      if (typeof args.filePath !== 'string') throw new Error('browser-upload-file-required')
      await this.uploadFile(this.element(args.target, observation), args.filePath, guard)
      verified = true
    } else if (method === 'scroll') {
      const direction = args.direction ?? 'down'
      const pages = args.pages ?? 1
      if (!['up', 'down', 'left', 'right'].includes(String(direction)) || typeof pages !== 'number' || !Number.isFinite(pages) || pages <= 0 || pages > 100) throw new Error('invalid-browser-scroll')
      const viewport = await this.viewport()
      let x: number, y: number
      if (Array.isArray(args.target)) [x, y] = await this.point(args.target, observation)
      else { const box = await this.box(this.element(args.target, observation)); x = box.x + box.width / 2; y = box.y + box.height / 2 }
      const vertical = direction === 'up' || direction === 'down'
      const amount = (vertical ? viewport.height : viewport.width) * pages * (direction === 'up' || direction === 'left' ? -1 : 1)
      await this.dispatchInput({ type: 'mouseWheel', x, y, deltaX: vertical ? 0 : amount, deltaY: vertical ? amount : 0 })
      cursor = { x, y, label: 'scroll', kind: 'scroll' }
    } else if (method === 'drag') {
      const from = await this.point(args.from, observation), to = await this.point(args.to, observation)
      await this.dispatchInput({ type: 'mouseMoved', x: from[0], y: from[1] }); guard()
      try {
        await this.dispatchInput({ type: 'mousePressed', x: from[0], y: from[1], button: 'left', clickCount: 1 })
        for (let step = 1; step <= 10; step++) {
          guard()
          await this.dispatchInput({ type: 'mouseMoved', x: from[0] + (to[0] - from[0]) * step / 10, y: from[1] + (to[1] - from[1]) * step / 10, button: 'left', buttons: 1 })
        }
      } finally { await this.dispatchInput({ type: 'mouseReleased', x: to[0], y: to[1], button: 'left', clickCount: 1 }) }
      cursor = { x: to[0], y: to[1], label: 'drag', kind: 'drag' }
    } else if (method === 'selectText') {
      if (typeof args.text !== 'string') throw new Error('browser-text-required')
      if ((args.prefix !== undefined && typeof args.prefix !== 'string') || (args.suffix !== undefined && typeof args.suffix !== 'string')) throw new Error('invalid-browser-selection-context')
      const selectionType = args.selectionType ?? 'text'
      if (!['text', 'cursor_before', 'cursor_after'].includes(String(selectionType))) throw new Error('invalid-browser-selection-type')
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
    guard()
    const fresh = await this.observe({ observationId: observation.observationId })
    return { result: { action: { method, status: verified ? 'verified' : 'dispatched' }, observation: fresh }, ...(cursor ? { cursor } : {}) }
  }

}

export class BrowserRuntimeRegistry {
  private targets = new Map<number, BrowserTargetRuntime>()

  async attach(contents: WebContents, identity: BrowserTargetIdentity): Promise<void> {
    const existing = this.targets.get(contents.id)
    if (existing) {
      existing.updateIdentity(identity)
      await existing.attach()
      return
    }
    const target = new BrowserTargetRuntime(contents, identity)
    this.targets.set(contents.id, target)
    contents.once('destroyed', () => this.targets.delete(contents.id))
    await target.attach()
  }

  noteUserInput(webContentsId: number): void {
    this.targets.get(webContentsId)?.noteUserInput()
  }

  isRegistered(webContentsId: number): boolean {
    return this.targets.has(webContentsId)
  }

  async execute(webContentsId: number, identity: BrowserTargetIdentity, method: string, args: BrowserArgs): Promise<BrowserRuntimeResult> {
    const target = this.targets.get(webContentsId)
    if (!target || !target.matches(identity)) return { error: 'browser-target-not-registered' }
    return target.execute(method, args)
  }

  async fillCredential(webContentsId: number, targetId: string, credential: { username: string; password: string }): Promise<{ ok?: true; error?: string }> {
    const target = this.targets.get(webContentsId)
    return target ? target.fillCredential(targetId, credential) : { error: 'browser-target-not-registered' }
  }
}

export const browserRuntime = new BrowserRuntimeRegistry()
