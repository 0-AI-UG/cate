import fs from 'fs'
import path from 'path'
import { app, type WebContents } from 'electron'
import {
  browserActivityLabel,
  browserCommandShowsActivity,
  isReadOnlyBrowserCommand,
  validateBrowserCommand,
} from '../../shared/browserCommand'

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

const INTERACTIVE_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'link', 'listbox', 'menuitem', 'option',
  'radio', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox',
])

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

function stringArg(args: BrowserArgs, key: string): string | undefined {
  return typeof args[key] === 'string' ? args[key] as string : undefined
}

function numberArg(args: BrowserArgs, key: string, fallback = 0): number {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function boolArg(args: BrowserArgs, key: string): boolean {
  return args[key] === true
}

function cursorKind(command: string): CursorKind {
  if (command === 'click') return 'click'
  if (command === 'dblclick') return 'dblclick'
  if (command === 'hover') return 'hover'
  if (command === 'drag') return 'drag'
  if (command === 'scroll') return 'scroll'
  if (command === 'fill' || command === 'type' || command === 'upload') return 'type'
  if (command === 'press') return 'press'
  return 'move'
}

function targetLabel(method: string, args: BrowserArgs): string {
  if (method === 'fill' || method === 'type') {
    const clean = String(args.text ?? '').replace(/\s+/g, ' ').trim()
    return `${method} ${JSON.stringify(clean.length > 28 ? `${clean.slice(0, 27)}…` : clean)}`
  }
  if (method === 'press') return `press ${String(args.key ?? '')}`.trim()
  return method
}

function globMatches(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')
  return new RegExp(`^${escaped}$`).test(value)
}

class BrowserTargetRuntime {
  readonly contents: WebContents
  identity: BrowserTargetIdentity
  private refs = new Map<string, RefTarget>()
  private snapshotRevision = 0
  private documentEpoch = 0
  private userInputEpoch = 0
  private agentInputDepth = 0
  private queue: Promise<unknown> = Promise.resolve()
  private consoleEntries: unknown[] = []
  private pageErrors: unknown[] = []
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
    const run = this.queue.then(() => this.executeBound(method, args), () => this.executeBound(method, args))
    this.queue = run.catch(() => undefined)
    return run.catch((error) => ({ error: error instanceof Error ? error.message : 'browser-command-failed' }))
  }

  async fillCredential(targetId: string, credential: { username: string; password: string }): Promise<{ ok?: true; error?: string }> {
    return this.executeExclusive(async (guard) => {
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
    }).catch((error) => ({ error: error instanceof Error ? error.message : 'credential-fill-failed' }))
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
        this.frameParents.clear()
      } else if (frameId) {
        this.frameParents.set(frameId, parentId)
        this.dropRefsForFrame(frameId, event.sessionId)
      }
      return
    }
    if (event.method === 'Runtime.consoleAPICalled') {
      this.consoleEntries.push(event.params)
      if (this.consoleEntries.length > 100) this.consoleEntries.shift()
      return
    }
    if (event.method === 'Runtime.exceptionThrown') {
      this.pageErrors.push(event.params)
      if (this.pageErrors.length > 100) this.pageErrors.shift()
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
      if (target.frameId === frameId || (sessionId && target.sessionId === sessionId)) this.refs.delete(ref)
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
      for (const [ref, target] of this.refs) if (target.sessionId === sessionId) this.refs.delete(ref)
    }
  }

  private async send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    await this.attach()
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
      await this.send('Input.dispatchMouseEvent', params)
    } finally {
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (!this.contents.isDestroyed()) this.contents.send('cate-browser-automation-input', false)
      this.agentInputDepth -= 1
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
    const epoch = this.userInputEpoch
    const guard = (): void => {
      if (this.contents.isDestroyed()) throw new Error('browser-target-destroyed')
      if (this.userInputEpoch !== epoch) throw new Error('browser-action-preempted-by-user')
    }
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

  private async resolveRef(ref: unknown): Promise<ElementTarget> {
    if (typeof ref !== 'string') throw new Error('ref-required')
    const normalized = ref.startsWith('@') ? ref : `@${ref}`
    const stored = this.refs.get(normalized)
    if (!stored || stored.documentEpoch !== this.documentEpoch) throw new Error('stale-browser-ref')
    return { backendNodeId: stored.backendNodeId, frameId: stored.frameId, sessionId: stored.sessionId }
  }

  private async resolveTarget(raw: unknown): Promise<ElementTarget> {
    return typeof raw === 'string' && /^@?s\d+e\d+$/.test(raw)
      ? this.resolveRef(raw)
      : this.resolveSelector(String(raw ?? ''))
  }

  private async resolveArgsTarget(args: BrowserArgs): Promise<ElementTarget> {
    if (args.ref !== undefined) return this.resolveRef(args.ref)
    if (stringArg(args, 'by') === 'css') return this.resolveSelector(stringArg(args, 'value') ?? '')
    const by = stringArg(args, 'by')
    const value = stringArg(args, 'value')
    if (!by || value === undefined) throw new Error('ref-or-locator-required')
    const selector = await this.semanticSelector(by, value, boolArg(args, 'exact'), numberArg(args, 'nth', -1))
    return this.resolveSelector(selector)
  }

  private async semanticSelector(by: string, value: string, exact: boolean, nth: number, accessibleName?: string): Promise<string> {
    const marker = `data-cate-runtime-target-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const expression = `(() => {
      const needle=${JSON.stringify(value)}, nameNeedle=${JSON.stringify(accessibleName ?? '')}, exact=${JSON.stringify(exact)};
      const text=(v)=>String(v||'').trim(); const match=(v)=>exact?text(v)===needle:text(v).toLowerCase().includes(needle.toLowerCase());
      const nameMatch=(v)=>!nameNeedle||(exact?text(v)===nameNeedle:text(v).toLowerCase().includes(nameNeedle.toLowerCase()));
      const labelFor=(el)=>el.labels?.[0]?.innerText||el.getAttribute('aria-label')||'';
      let nodes=[];
      switch(${JSON.stringify(by)}) {
        case 'role': nodes=Array.from(document.querySelectorAll('[role="'+CSS.escape(needle)+'"],button,a,input,select,textarea')); nodes=nodes.filter(el=>(el.getAttribute('role')||({BUTTON:'button',A:'link',SELECT:'combobox',TEXTAREA:'textbox',INPUT:el.type==='search'?'searchbox':el.type==='checkbox'?'checkbox':el.type==='radio'?'radio':'textbox'}[el.tagName]))===needle&&nameMatch(el.getAttribute('aria-label')||el.innerText||el.value)); break;
        case 'label': nodes=Array.from(document.querySelectorAll('input,select,textarea,button')).filter(el=>match(labelFor(el))); break;
        case 'placeholder': nodes=Array.from(document.querySelectorAll('[placeholder]')).filter(el=>match(el.getAttribute('placeholder'))); break;
        case 'testid': nodes=Array.from(document.querySelectorAll('[data-testid]')).filter(el=>match(el.getAttribute('data-testid'))); break;
        case 'altText': case 'alt': nodes=Array.from(document.querySelectorAll('[alt]')).filter(el=>match(el.getAttribute('alt'))); break;
        case 'title': nodes=Array.from(document.querySelectorAll('[title]')).filter(el=>match(el.getAttribute('title'))); break;
        case 'text': nodes=Array.from(document.querySelectorAll('button,a,label,h1,h2,h3,p,span,div')).filter(el=>match(el.innerText)); break;
      }
      const target=nodes[${nth >= 0 ? nth : 0}]||null; if(!target)return false; target.setAttribute(${JSON.stringify(marker)},''); return true;
    })()`
    const result = objectValue((await this.send('Runtime.evaluate', { expression, returnByValue: true })).result)
    if (result.value !== true) throw new Error('element-not-found')
    return `[${marker}]`
  }

  private async callOn(target: ElementTarget, functionDeclaration: string, returnByValue = true): Promise<Record<string, unknown>> {
    let objectId = target.objectId
    if (!objectId) {
      const resolved = await this.send('DOM.resolveNode', { backendNodeId: target.backendNodeId, objectGroup: 'cate-browser' }, target.sessionId)
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

  private async box(target: ElementTarget): Promise<{ x: number; y: number; width: number; height: number }> {
    await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: target.backendNodeId }, target.sessionId)
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
    const offset = await this.frameOffset(target.frameId)
    return { ...local, x: local.x + offset.x, y: local.y + offset.y }
  }

  private async frameOffset(frameId: string): Promise<{ x: number; y: number }> {
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
      await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }, parentSession)
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
    guard()
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await this.dispatchInput({ type: 'mouseMoved', x, y })
    await this.dispatchInput({ type: 'mousePressed', x, y, button, clickCount: count })
    guard()
    await this.dispatchInput({ type: 'mouseReleased', x, y, button, clickCount: count })
    return this.cursor(box, count === 2 ? 'dblclick' : 'click', count === 2 ? 'dblclick' : 'click')
  }

  private async focusElement(target: ElementTarget): Promise<void> {
    await this.send('DOM.focus', { backendNodeId: target.backendNodeId }, target.sessionId)
  }

  private async fillElement(target: ElementTarget, text: string, guard: () => void): Promise<void> {
    await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: target.backendNodeId }, target.sessionId)
    // Focus stays inside this CDP target's document. It does not activate the
    // Electron window, so xterm/Monaco focus in the host remains untouched.
    await this.focusElement(target)
    guard()
    await this.callOn(target, `function () {
      const text=${JSON.stringify(text)};
      if (this.isContentEditable) this.textContent=text;
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
    await this.focusElement(target)
    guard()
    await this.callOn(target, `function () {
      const addition=${JSON.stringify(text)};
      if (this.isContentEditable) this.textContent=(this.textContent||'')+addition;
      else {
        const next=String(this.value||'')+addition;
        const proto=this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;
        if (setter) setter.call(this,next); else this.value=next;
      }
      this.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:addition}));
    }`)
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
    const parts = keySpec.replace(/^cmd\+/i, 'Meta+').split('+')
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
          if (target instanceof HTMLButtonElement) target.click();
          else if (!(target instanceof HTMLTextAreaElement) && target.form) target.form.requestSubmit();
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
    await this.dispatchKey({ type: 'rawKeyDown', ...data, modifiers })
    guard()
    await this.dispatchKey({ type: 'keyUp', ...data, modifiers })
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

  private async snapshot(args: BrowserArgs = {}): Promise<Record<string, unknown>> {
    const frameIds = await this.currentFrameIds()
    const mainFrameId = frameIds[0]
    const trees: Array<{ nodes: Record<string, unknown>[]; frameId?: string; sessionId?: string }> = []
    const rootTree = await this.send('Accessibility.getFullAXTree')
    trees.push({
      nodes: Array.isArray(rootTree.nodes) ? rootTree.nodes.map(objectValue) : [],
      frameId: mainFrameId,
    })
    for (const frameId of frameIds.slice(1)) {
      const sessionId = this.frameSessions.get(frameId)
      try {
        const tree = sessionId
          ? await this.send('Accessibility.getFullAXTree', {}, sessionId)
          : await this.send('Accessibility.getFullAXTree', { frameId })
        trees.push({
          nodes: Array.isArray(tree.nodes) ? tree.nodes.map(objectValue) : [],
          frameId,
          sessionId,
        })
      } catch {
        // A frame can detach between Page.getFrameTree and the AX query.
      }
    }
    this.snapshotRevision += 1
    this.refs.clear()
    const snapshotId = `s${this.snapshotRevision}`
    const refs: Array<{ ref: string; role: string; name: string }> = []
    const lines: string[] = []
    const interactiveOnly = args.interactiveOnly === true
      || (Array.isArray(args.command) && (args.command as unknown[]).includes('-i'))
    let index = 0
    const seen = new Set<string>()
    for (const source of trees) {
      for (const node of source.nodes) {
        const role = String(objectValue(node.role).value ?? '')
        const name = String(objectValue(node.name).value ?? '')
        const backendNodeId = typeof node.backendDOMNodeId === 'number' ? node.backendDOMNodeId : undefined
        if (!backendNodeId || !role || role === 'RootWebArea' || (interactiveOnly && !INTERACTIVE_ROLES.has(role))) continue
        if (node.ignored === true) continue
        const identity = `${source.sessionId ?? 'root'}:${backendNodeId}`
        if (seen.has(identity)) continue
        seen.add(identity)
        index += 1
        const ref = `@${snapshotId}e${index}`
        this.refs.set(ref, {
          backendNodeId,
          documentEpoch: this.documentEpoch,
          frameId: source.frameId,
          sessionId: source.sessionId,
        })
        refs.push({ ref, role, name })
        let suffix = ''
        if (role === 'textbox' || role === 'searchbox') {
          const described = await this.send('DOM.describeNode', { backendNodeId }, source.sessionId)
          const attrs = objectValue(described.node).attributes
          if (Array.isArray(attrs)) {
            const typeAt = attrs.findIndex((part) => part === 'type')
            if (typeAt >= 0 && attrs[typeAt + 1] === 'password') suffix = ' value="••••••••"'
          }
        }
        lines.push(`- ${role}${name ? ` ${JSON.stringify(name)}` : ''}${suffix} [ref=${ref.slice(1)}]`)
      }
    }
    return {
      snapshotId,
      url: this.contents.getURL(),
      title: this.contents.getTitle(),
      refs,
      snapshot: lines.join('\n'),
    }
  }

  private async evaluate(expression: string): Promise<unknown> {
    const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (response.exceptionDetails) throw new Error('page-evaluation-failed')
    return objectValue(response.result).value ?? null
  }

  private async getValue(kind: string, targetRaw?: unknown, attr?: string): Promise<Record<string, unknown>> {
    if (kind === 'url') return { origin: this.contents.getURL(), url: this.contents.getURL() }
    if (kind === 'title') return { origin: this.contents.getURL(), title: this.contents.getTitle() }
    const target = await this.resolveTarget(targetRaw)
    let expression: string
    if (kind === 'text') expression = 'function () { return this.innerText ?? this.textContent ?? ""; }'
    else if (kind === 'value') expression = 'function () { return this.type === "password" ? "" : (this.value ?? ""); }'
    else if (kind === 'html') expression = 'function () { return this.outerHTML; }'
    else if (kind === 'attr') expression = `function () { return this.getAttribute(${JSON.stringify(attr ?? '')}); }`
    else if (kind === 'box') {
      const box = await this.box(target)
      return { origin: this.contents.getURL(), ...box }
    } else throw new Error(`unsupported-get:${kind}`)
    const result = await this.callOn(target, expression)
    return { origin: this.contents.getURL(), value: result.value ?? null, ...(kind === 'text' ? { text: result.value ?? '' } : {}) }
  }

  private async state(kind: string, targetRaw: unknown): Promise<Record<string, unknown>> {
    const target = await this.resolveTarget(targetRaw)
    const result = await this.callOn(target, `function () {
      const style=getComputedStyle(this), rect=this.getBoundingClientRect();
      return { visible:style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0,
        enabled:!this.disabled, checked:Boolean(this.checked) };
    }`)
    const value = objectValue(result.value)
    return { origin: this.contents.getURL(), [kind]: value[kind] ?? false }
  }

  private async screenshot(fullPage = false, targetRaw?: unknown): Promise<{ path: string }> {
    const filePath = path.join(app.getPath('temp'), 'cate-screenshots', `screenshot-${Date.now()}.png`)
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
    let params: Record<string, unknown> = { format: 'png', captureBeyondViewport: fullPage }
    if (targetRaw !== undefined) {
      const box = await this.box(await this.resolveTarget(targetRaw))
      params = { ...params, clip: { ...box, scale: 1 } }
    } else if (fullPage) {
      const metrics = await this.send('Page.getLayoutMetrics')
      const size = objectValue(metrics.cssContentSize)
      if (typeof size.width === 'number' && typeof size.height === 'number') {
        params = { ...params, clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } }
      }
    }
    const response = await this.send('Page.captureScreenshot', params)
    if (typeof response.data !== 'string') throw new Error('browser-screenshot-failed')
    await fs.promises.writeFile(filePath, Buffer.from(response.data, 'base64'))
    return { path: filePath }
  }

  private async waitFor(command: string[], timeoutMs: number): Promise<void> {
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 1), 30_000)
    for (;;) {
      let ready = false
      if (command[0] === '--text') ready = String(await this.evaluate('document.body?.innerText ?? ""')).includes(command[1] ?? '')
      else if (command[0] === '--url') ready = globMatches(this.contents.getURL(), command[1] ?? '')
      else if (command[0] === '--load') ready = !this.contents.isLoading()
      else if (command[0] === '--fn') ready = Boolean(await this.evaluate(command.slice(1).join(' ')))
      else if (command[0]) {
        try {
          const target = await this.resolveTarget(command[0])
          const state = command.includes('--state') ? command[command.indexOf('--state') + 1] : 'visible'
          const visible = (await this.callOn(target, `function () { const s=getComputedStyle(this),r=this.getBoundingClientRect(); return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0; }`)).value
          ready = state === 'attached' || (state === 'visible' && visible === true) || (state === 'hidden' && visible !== true)
        } catch {
          const state = command.includes('--state') ? command[command.indexOf('--state') + 1] : 'visible'
          ready = state === 'hidden' || state === 'detached'
        }
      } else ready = !this.contents.isLoading()
      if (ready) return
      if (Date.now() >= deadline) throw new Error('browser-wait-timeout')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  private async rawCommand(method: 'command' | 'readCommand', raw: unknown): Promise<BrowserRuntimeResult> {
    const command = validateBrowserCommand(raw)
    if (method === 'readCommand' && !isReadOnlyBrowserCommand(command)) return { error: 'browser-command-requires-control' }
    const [root, ...rest] = command
    if (root === 'snapshot') return { result: await this.snapshot({ command }) }
    if (root === 'get') return { result: await this.getValue(rest[0], rest[1], rest[2]) }
    if (root === 'is') return { result: await this.state(rest[0], rest[1]) }
    if (root === 'eval') return { result: { result: await this.evaluate(rest.join(' ')) } }
    if (root === 'console') {
      const result = { messages: [...this.consoleEntries] }
      if (rest.includes('--clear')) this.consoleEntries = []
      return { result }
    }
    if (root === 'errors') {
      const result = { errors: [...this.pageErrors] }
      if (rest.includes('--clear')) this.pageErrors = []
      return { result }
    }
    if (root === 'screenshot') {
      const target = rest.find((part) => /^@s\d+e\d+$/.test(part))
      return { result: await this.screenshot(rest.includes('--full') || rest.includes('-f'), target) }
    }
    if (root === 'wait') {
      const timeoutIndex = rest.indexOf('--timeout')
      const timeout = timeoutIndex >= 0 ? Number(rest[timeoutIndex + 1]) : (rest[0] && /^\d+$/.test(rest[0]) ? Number(rest[0]) : 5_000)
      const condition = rest.filter((_part, index) => (timeoutIndex < 0 || (index !== timeoutIndex && index !== timeoutIndex + 1)) && !(/^\d+$/.test(rest[0]) && index === 0))
      await this.waitFor(condition, timeout)
      return { result: { url: this.contents.getURL(), title: this.contents.getTitle(), loading: this.contents.isLoading() } }
    }

    if (root === 'find') {
      const exact = rest.includes('--exact')
      const nameIndex = rest.indexOf('--name')
      const accessibleName = nameIndex >= 0 ? rest[nameIndex + 1] : undefined
      const findArgs = rest.filter((_part, index) => (nameIndex < 0 || (index !== nameIndex && index !== nameIndex + 1)) && rest[index] !== '--exact')
      const [by, value, action, ...actionArgs] = findArgs
      if (!by || value === undefined || !action) return { error: 'find-requires-locator-and-action' }
      const selector = await this.semanticSelector(by, value, exact, -1, accessibleName)
      if (action === 'text') return { result: await this.getValue('text', selector) }
      return this.rawCommand(method, [action, selector, ...actionArgs])
    }

    return this.executeExclusive(async (guard) => {
      let cursor: BrowserRuntimeResult['cursor']
      if (root === 'click' || root === 'dblclick') {
        const target = await this.resolveTarget(rest[0])
        cursor = await this.clickElement(target, root === 'dblclick' ? 2 : 1, 'left', guard)
      } else if (root === 'hover' || root === 'focus' || root === 'scrollintoview') {
        const target = await this.resolveTarget(rest[0])
        const box = await this.box(target)
        if (root === 'hover') await this.dispatchInput({ type: 'mouseMoved', x: box.x + box.width / 2, y: box.y + box.height / 2 })
        if (root === 'focus') await this.focusElement(target)
        cursor = this.cursor(box, root, root === 'hover' ? 'hover' : 'move')
      } else if (root === 'fill' || root === 'type') {
        const target = await this.resolveTarget(rest[0])
        const box = await this.box(target)
        if (root === 'fill') await this.fillElement(target, rest[1] ?? '', guard)
        else await this.typeElement(target, rest[1] ?? '', guard)
        cursor = this.cursor(box, browserActivityLabel(command), 'type')
      } else if (root === 'upload') {
        const target = await this.resolveTarget(rest[0])
        const box = await this.box(target)
        const name = await this.uploadFile(target, rest[1], guard)
        return { result: { ok: true, files: [name] }, cursor: this.cursor(box, 'upload', 'type') }
      } else if (root === 'press') {
        await this.pressKey(rest[0] ?? '', guard)
        cursor = { label: browserActivityLabel(command), kind: 'press' }
      } else if (root === 'keyboard' && (rest[0] === 'type' || rest[0] === 'inserttext')) {
        const active = objectValue((await this.send('Runtime.evaluate', { expression: 'document.activeElement', returnByValue: false, objectGroup: 'cate-browser' })).result)
        if (typeof active.objectId !== 'string') throw new Error('type-target-required')
        const described = await this.send('DOM.describeNode', { objectId: active.objectId })
        const backendNodeId = objectValue(described.node).backendNodeId
        if (typeof backendNodeId !== 'number') throw new Error('type-target-required')
        await this.typeElement({ objectId: active.objectId, backendNodeId }, rest.slice(1).join(' '), guard)
      } else if (root === 'select') {
        const target = await this.resolveTarget(rest[0])
        await this.callOn(target, `function () { const values=${JSON.stringify(rest.slice(1))}; for(const option of this.options||[]) option.selected=values.includes(option.value)||values.includes(option.text); this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true})); }`)
      } else if (root === 'check' || root === 'uncheck') {
        const target = await this.resolveTarget(rest[0])
        const checked = (await this.callOn(target, 'function () { return Boolean(this.checked); }')).value === true
        if ((root === 'check') !== checked) cursor = await this.clickElement(target, 1, 'left', guard)
      } else if (root === 'scroll') {
        if (rest[0] === 'top' || rest[0] === 'bottom') await this.evaluate(`scrollTo(0,${rest[0] === 'top' ? '0' : 'document.documentElement.scrollHeight'})`)
        else {
          const distance = Number(rest[1] ?? rest[0] ?? 0)
          await this.dispatchInput({ type: 'mouseWheel', x: 1, y: 1, deltaY: rest[0] === 'up' ? -distance : distance, deltaX: 0 })
        }
      } else if (root === 'mouse') {
        const action = rest[0]
        if (action === 'move') await this.dispatchInput({ type: 'mouseMoved', x: Number(rest[1]), y: Number(rest[2]) })
        else if (action === 'wheel') await this.dispatchInput({ type: 'mouseWheel', x: 1, y: 1, deltaY: Number(rest[1]), deltaX: Number(rest[2] ?? 0) })
        else throw new Error(`unsupported-mouse-action:${action}`)
      } else {
        throw new Error(`unsupported-browser-command:${root}`)
      }
      return { result: { ok: true }, ...(browserCommandShowsActivity(command) ? { cursor: { ...cursor, label: cursor?.label || browserActivityLabel(command), kind: cursor?.kind || cursorKind(root) } } : {}) }
    })
  }

  private async executeBound(method: string, args: BrowserArgs): Promise<BrowserRuntimeResult> {
    if (method === 'command' || method === 'readCommand') return this.rawCommand(method, args.command)
    if (method === 'snapshot') return { result: await this.snapshot(args) }
    if (method === 'evaluate') {
      const expression = stringArg(args, 'expression')
      return expression ? { result: { value: await this.evaluate(expression) } } : { error: 'expression-required' }
    }
    if (method === 'screenshot') return { result: await this.screenshot(stringArg(args, 'mode') === 'fullPage', stringArg(args, 'mode') === 'element' ? args.ref : undefined) }
    if (method === 'console') return { result: { messages: [...this.consoleEntries] } }
    if (method === 'consoleClear') { this.consoleEntries = []; return {}
    }
    if (method === 'text') return { result: await this.getValue('text', args.ref ?? 'body') }
    if (method === 'attrs') return { result: await this.getValue('html', args.ref) }
    if (method === 'state') {
      const target = await this.resolveArgsTarget(args)
      const value = objectValue((await this.callOn(target, 'function () { const s=getComputedStyle(this),r=this.getBoundingClientRect(); return {visible:s.display!=="none"&&s.visibility!=="hidden"&&r.width>0&&r.height>0,enabled:!this.disabled,checked:Boolean(this.checked)}; }')).value)
      return { result: value }
    }
    if (method === 'assets') return { result: await this.evaluate(`Array.from(document.images).slice(0,${Math.max(0, numberArg(args, 'max', 50))}).map(i=>({src:i.currentSrc||i.src,alt:i.alt,width:i.naturalWidth,height:i.naturalHeight}))`) }
    if (method === 'wait') {
      const condition = objectValue(args.condition)
      let command: string[] = []
      if (condition.kind === 'text') command = ['--text', String(condition.value)]
      else if (condition.kind === 'textGone') {
        const deadline = Date.now() + Math.min(Math.max(numberArg(args, 'timeoutMs', 5_000), 1), 30_000)
        while (String(await this.evaluate('document.body?.innerText ?? ""')).includes(String(condition.value))) {
          if (Date.now() >= deadline) throw new Error('browser-wait-timeout')
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      } else if (condition.kind === 'url') command = ['--url', String(condition.value)]
      else if (condition.kind === 'load') command = ['--load', 'load']
      else if (condition.kind === 'ref') command = [String(condition.ref), '--state', String(condition.state ?? 'visible')]
      if (condition.kind !== 'textGone') await this.waitFor(command, numberArg(args, 'timeoutMs', 5_000))
      const base = { url: this.contents.getURL(), title: this.contents.getTitle(), loading: this.contents.isLoading() }
      return { result: boolArg(args, 'includeSnapshot') ? { ...base, snapshot: await this.snapshot() } : base }
    }

    return this.executeExclusive(async (guard) => {
      if (method === 'press') {
        if (args.ref !== undefined || args.by !== undefined) await this.focusElement(await this.resolveArgsTarget(args))
        const key = stringArg(args, 'key')
        if (!key) return { error: 'key-required' }
        await this.pressKey(key, guard)
        return this.complete(method, args, undefined)
      }
      if (method === 'scroll') {
        if (args.ref !== undefined) {
          const target = await this.resolveRef(args.ref)
          await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: target.backendNodeId }, target.sessionId)
        }
        const to = stringArg(args, 'to')
        if (to) await this.evaluate(`scrollTo(0,${to === 'top' ? '0' : 'document.documentElement.scrollHeight'})`)
        else await this.dispatchInput({ type: 'mouseWheel', x: 1, y: 1, deltaY: numberArg(args, 'dy'), deltaX: numberArg(args, 'dx') })
        return this.complete(method, args, undefined)
      }
      if (method === 'mouse') {
        const x = numberArg(args, 'x', -1), y = numberArg(args, 'y', -1)
        if (x < 0 || y < 0) return { error: 'x-and-y-required' }
        await this.dispatchInput({ type: 'mouseMoved', x, y })
        if (stringArg(args, 'action') !== 'move') {
          const button = stringArg(args, 'button') ?? 'left'
          await this.dispatchInput({ type: 'mousePressed', x, y, button, clickCount: 1 })
          await this.dispatchInput({ type: 'mouseReleased', x, y, button, clickCount: 1 })
        }
        return this.complete(method, args, undefined)
      }
      if (method === 'clickAt') {
        const x = numberArg(args, 'x', -1), y = numberArg(args, 'y', -1)
        if (x < 0 || y < 0) return { error: 'x-and-y-required' }
        await this.dispatchInput({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
        await this.dispatchInput({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
        return { result: { ok: true } }
      }
      const target = await this.resolveArgsTarget(args)
      const box = await this.box(target)
      if (method === 'click' || method === 'dblclick' || method === 'hover') {
        if (method === 'hover') await this.dispatchInput({ type: 'mouseMoved', x: box.x + box.width / 2, y: box.y + box.height / 2 })
        else await this.clickElement(target, method === 'dblclick' ? 2 : numberArg(args, 'count', 1), stringArg(args, 'button') ?? 'left', guard)
      } else if (method === 'fill') await this.fillElement(target, stringArg(args, 'text') ?? '', guard)
      else if (method === 'type') await this.typeElement(target, stringArg(args, 'text') ?? '', guard)
      else if (method === 'focus') await this.focusElement(target)
      else if (method === 'select') {
        const values = Array.isArray(args.values) ? args.values.filter((value): value is string => typeof value === 'string') : []
        await this.callOn(target, `function () { const values=${JSON.stringify(values)}; for(const option of this.options||[]) option.selected=values.includes(option.value)||values.includes(option.text); this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true})); }`)
      } else if (method === 'check' || method === 'uncheck') {
        const checked = (await this.callOn(target, 'function () { return Boolean(this.checked); }')).value === true
        if ((method === 'check') !== checked) await this.clickElement(target, 1, 'left', guard)
      } else return { error: 'unsupported' }
      return this.complete(method, args, box)
    })
  }

  private async complete(method: string, args: BrowserArgs, box?: { x: number; y: number; width: number; height: number }): Promise<BrowserRuntimeResult> {
    const result = boolArg(args, 'includeSnapshot') ? { ok: true, snapshot: await this.snapshot() } : { ok: true }
    return { result, cursor: box ? this.cursor(box, targetLabel(method, args), cursorKind(method)) : { label: targetLabel(method, args), kind: cursorKind(method) } }
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
