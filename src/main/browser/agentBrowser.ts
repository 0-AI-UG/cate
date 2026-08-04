import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { app, type WebContents } from 'electron'
import log from '../logger'
import {
  agentBrowserActivityLabel,
  agentBrowserCommandShowsActivity,
  isReadOnlyAgentBrowserCommand,
  validateAgentBrowserCommand,
} from '../../shared/agentBrowserCommand'

const TARGET_MARKER = '__cateAgentBrowserTarget'
const CONNECT_TIMEOUT_MS = 8_000
const COMMAND_TIMEOUT_MS = 28_000
const BIND_ATTEMPTS = 8
const BIND_RETRY_MS = 75
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const SESSION = 'cate'
const NAMESPACE = 'cate'
const AUTOFILL_USERNAME_MARKER = 'data-cate-autofill-username-target'
type Runner = (args: string[]) => Promise<unknown>

let runtimeSocketDir: string | null = null

interface RegisteredTarget {
  contents: WebContents
  token: string
  panelId: string
  tabId: string
  agentTabId: string | null
  revision: number
  refs: Map<string, string>
}

interface AgentBrowserEnvelope {
  success?: boolean
  data?: unknown
  error?: unknown
}

export interface AgentBrowserResult {
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

type BrowserArgs = Record<string, unknown>

/** Enable Chromium's loopback CDP endpoint before Electron becomes ready. */
export function enableAgentBrowserBackend(): void {
  if (!app.commandLine.hasSwitch('remote-debugging-port')) {
    app.commandLine.appendSwitch('remote-debugging-port', '0')
  }
}

function binaryName(): string {
  const platform = process.platform
  const arch = process.arch
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) {
    return `agent-browser-darwin-${arch}`
  }
  if (platform === 'win32' && arch === 'x64') return 'agent-browser-win32-x64.exe'
  if (platform === 'linux' && (arch === 'arm64' || arch === 'x64')) {
    return `agent-browser-linux-${arch}`
  }
  throw new Error(`agent-browser does not support ${platform}-${arch}`)
}

/** Resolve the native executable directly. This avoids the package's Node
 * wrapper and therefore works with Cate's Node 20-22 development toolchain. */
export function agentBrowserBinaryPath(): string {
  const packageJson = require.resolve('agent-browser/package.json')
  const packed = path.join(path.dirname(packageJson), 'bin', binaryName())
  const resolved = packed.includes('app.asar')
    ? packed.replace('app.asar', 'app.asar.unpacked')
    : packed
  if (process.platform !== 'win32') {
    try {
      fs.accessSync(resolved, fs.constants.X_OK)
    } catch {
      fs.chmodSync(resolved, 0o755)
    }
  }
  return resolved
}

async function readDevToolsPort(): Promise<string> {
  const file = path.join(app.getPath('userData'), 'DevToolsActivePort')
  const deadline = Date.now() + CONNECT_TIMEOUT_MS
  for (;;) {
    try {
      const [port] = (await fs.promises.readFile(file, 'utf8')).trim().split(/\r?\n/, 1)
      if (port) return port
    } catch {
      // Chromium writes this file asynchronously after app-ready.
    }
    if (Date.now() >= deadline) throw new Error('DevToolsActivePort was not created')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function parseEnvelope(stdout: string): unknown {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)
  if (!line) throw new Error('agent-browser returned no output')
  let envelope: AgentBrowserEnvelope
  try {
    envelope = JSON.parse(line) as AgentBrowserEnvelope
  } catch {
    throw new Error(`agent-browser returned invalid JSON: ${line.slice(0, 200)}`)
  }
  if (envelope.success === false || envelope.error) {
    throw new Error(typeof envelope.error === 'string' ? envelope.error : 'agent-browser command failed')
  }
  const data = envelope.data
  if (data && typeof data === 'object') {
    const clean = { ...(data as Record<string, unknown>) }
    delete clean.lifecycle
    return clean
  }
  return data
}

function defaultRunner(): Runner {
  return async (args) => new Promise((resolve, reject) => {
    const configDir = path.join(app.getPath('userData'), 'agent-browser')
    fs.mkdirSync(configDir, { recursive: true })
    const configPath = path.join(configDir, 'cate-config.json')
    if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, '{}\n', { mode: 0o600 })
    runtimeSocketDir ??= fs.mkdtempSync(path.join(app.getPath('temp'), 'cate-ab-'))
    const socketDir = runtimeSocketDir
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (key.startsWith('AGENT_BROWSER_')) delete env[key]
    }
    execFile(
      agentBrowserBinaryPath(),
      ['--config', configPath, '--session', SESSION, '--namespace', NAMESPACE, '--json', ...args],
      {
        env: {
          ...env,
          AGENT_BROWSER_SOCKET_DIR: socketDir,
          AGENT_BROWSER_IDLE_TIMEOUT_MS: '60000',
        },
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || stdout.trim() || error.message))
          return
        }
        try {
          resolve(parseEnvelope(stdout))
        } catch (parseError) {
          reject(parseError)
        }
      },
    )
  })
}

function credentialTargetScript(targetId: string, usernameElement: string): string {
  return `(() => {
    const targetId = ${JSON.stringify(targetId)};
    const usernameName = ${JSON.stringify(usernameElement)};
    const password = [...document.querySelectorAll('[data-cate-autofill-target]')]
      .find((element) => element.getAttribute('data-cate-autofill-target') === targetId);
    if (!(password instanceof HTMLInputElement) || password.type.toLowerCase() !== 'password') {
      return { password: false, username: false };
    }
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return !element.disabled && style.display !== 'none' && style.visibility !== 'hidden'
        && rect.width > 0 && rect.height > 0;
    };
    const scope = password.form ?? document.body;
    let username = usernameName
      ? [...document.querySelectorAll('input')].find((element) => element.name === usernameName && visible(element))
      : undefined;
    if (!username) {
      username = [...scope.querySelectorAll(
        'input[autocomplete="username"], input[autocomplete="email"], input[type="email"], input[type="text"]',
      )].filter(visible).at(-1);
    }
    if (username) username.setAttribute(${JSON.stringify(AUTOFILL_USERNAME_MARKER)}, targetId);
    return { password: true, username: Boolean(username) };
  })()`
}

function clearCredentialTargetScript(targetId: string): string {
  return `for (const element of document.querySelectorAll('[${AUTOFILL_USERNAME_MARKER}]')) {
    if (element.getAttribute(${JSON.stringify(AUTOFILL_USERNAME_MARKER)}) === ${JSON.stringify(targetId)}) {
      element.removeAttribute(${JSON.stringify(AUTOFILL_USERNAME_MARKER)});
    }
  }; true`
}

function fillElementScript(selector: string, text: string, append = false): string {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return { error: 'element-not-found' };
    const text = ${JSON.stringify(text)};
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (!setter) return { error: 'element-not-editable' };
      setter.call(element, ${append ? 'element.value + text' : 'text'});
    } else if (element.isContentEditable) {
      element.textContent = ${append ? '(element.textContent ?? "") + text' : 'text'};
    } else {
      return { error: 'element-not-editable' };
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: text }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return { value: 'value' in element ? element.value : element.textContent ?? '' };
  })()`
}

function elementActionScript(selector: string, action: 'click' | 'dblclick' | 'focus' | 'hover'): string {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return { error: 'element-not-found' };
    ${action === 'focus'
      ? 'element.focus();'
      : action === 'hover'
        ? "element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true }));"
      : action === 'dblclick'
        ? "element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true, cancelable: true }));"
        : 'element.click();'}
    return { ok: true };
  })()`
}

function markerScript(token: string): string {
  const key = JSON.stringify(TARGET_MARKER)
  return `if (!Object.prototype.hasOwnProperty.call(globalThis, ${key})) { ` +
    `Object.defineProperty(globalThis, ${key}, ` +
    `{ value: ${JSON.stringify(token)}, configurable: false, enumerable: false, writable: false }) }; true`
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

function targetLabel(method: string, args: BrowserArgs): string {
  const text = stringArg(args, 'text')
  if (method === 'fill' || method === 'type') {
    const clean = (text ?? '').replace(/\s+/g, ' ').trim()
    const short = clean.length > 28 ? `${clean.slice(0, 27)}…` : clean
    return `${method} ${JSON.stringify(short)}`
  }
  if (method === 'press') return `press ${stringArg(args, 'key') ?? ''}`.trim()
  return method
}

function cursorKind(method: string): NonNullable<AgentBrowserResult['cursor']>['kind'] {
  if (method === 'dblclick') return 'dblclick'
  if (method === 'hover') return 'hover'
  if (method === 'drag') return 'drag'
  if (method === 'scroll' || method === 'mouse') return method === 'scroll' ? 'scroll' : 'move'
  if (method === 'fill' || method === 'type' || method === 'select' || method === 'check' || method === 'uncheck') {
    return 'type'
  }
  if (method === 'press') return 'press'
  return 'click'
}

export class AgentBrowserService {
  private readonly targets = new Map<number, RegisteredTarget>()
  private readonly run: Runner
  private readonly endpoint: () => Promise<string>
  private connected = false
  private selectedTargetId: number | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: { runner?: Runner; endpoint?: () => Promise<string> } = {}) {
    this.run = options.runner ?? defaultRunner()
    this.endpoint = options.endpoint ?? readDevToolsPort
  }

  register(contents: WebContents, panelId: string, tabId: string): Promise<void> {
    // The native daemon can outlive or expire before this Electron process.
    // A fresh guest registration must therefore refresh the CDP connection
    // instead of trusting the in-process flag.
    this.connected = false
    let target = this.targets.get(contents.id)
    if (!target) {
      target = {
        contents,
        token: randomUUID(),
        panelId,
        tabId,
        agentTabId: null,
        revision: 0,
        refs: new Map(),
      }
      this.targets.set(contents.id, target)
      contents.once('destroyed', () => {
        this.targets.delete(contents.id)
        if (this.selectedTargetId === contents.id) this.selectedTargetId = null
      })
    } else {
      target.panelId = panelId
      target.tabId = tabId
      target.agentTabId = null
      target.refs.clear()
    }

    const current = target
    return this.serial(async () => {
      await current.contents.executeJavaScript(markerScript(current.token), true)
      await this.bind(current)
    }).then(() => undefined)
  }

  async execute(webContentsId: number, method: string, args: BrowserArgs): Promise<AgentBrowserResult> {
    const target = this.targets.get(webContentsId)
    if (!target) return { error: 'agent-browser-target-not-registered' }
    try {
      return await this.serial(async () => {
        await this.selectBound(target)
        return this.executeBound(target, method, args)
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn('[browser:agent-browser] %s failed: %s', method, message)
      return { error: message || 'agent-browser-command-failed' }
    }
  }

  async fillCredential(
    webContentsId: number,
    targetId: string,
    credential: { username: string; password: string; usernameElement: string },
  ): Promise<{ ok?: true; error?: string }> {
    if (!/^[0-9a-f-]{36}$/i.test(targetId)) return { error: 'invalid-autofill-target' }
    const target = this.targets.get(webContentsId)
    if (!target) return { error: 'agent-browser-target-not-registered' }
    try {
      await this.serial(async () => {
        await this.selectBound(target)
        const prepared = objectValue(objectValue(await this.run([
          'eval',
          credentialTargetScript(targetId, credential.usernameElement),
        ])).result)
        if (prepared.password !== true) throw new Error('autofill-target-not-password')
        try {
          if (credential.username && prepared.username === true) {
            await this.evaluatePage(fillElementScript(
              `[${AUTOFILL_USERNAME_MARKER}=${JSON.stringify(targetId)}]`,
              credential.username,
            ))
          }
          await this.evaluatePage(fillElementScript(
            `[data-cate-autofill-target=${JSON.stringify(targetId)}]`,
            credential.password,
          ))
        } finally {
          await this.run(['eval', clearCredentialTargetScript(targetId)]).catch(() => undefined)
        }
      })
      return { ok: true }
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'credential-autofill-failed' }
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) return
    await this.run(['connect', await this.endpoint()])
    this.connected = true
  }

  private invalidateRefs(): void {
    for (const target of this.targets.values()) target.refs.clear()
    this.selectedTargetId = null
  }

  private async bind(target: RegisteredTarget): Promise<void> {
    await this.ensureConnected()
    let discovered: string[] = []
    let probeErrors: string[] = []
    for (let attempt = 0; attempt < BIND_ATTEMPTS; attempt += 1) {
      const listed = objectValue(await this.run(['tab']))
      const tabs = Array.isArray(listed.tabs) ? listed.tabs : []
      discovered = tabs.map((raw) => {
        const tab = objectValue(raw)
        return `${String(tab.tabId ?? '?')}:${String(tab.type ?? 'unknown')}`
      })
      probeErrors = []
      for (const raw of tabs) {
        const tab = objectValue(raw)
        if (typeof tab.tabId !== 'string') continue
        try {
          // agent-browser invalidates its snapshot refs on every tab command,
          // including when selecting the already-active tab.
          this.invalidateRefs()
          await this.run(['tab', tab.tabId])
          const evaluated = objectValue(await this.run([
            'eval',
            `globalThis[${JSON.stringify(TARGET_MARKER)}] ?? null`,
          ]))
          if (evaluated.result === target.token) {
            target.agentTabId = tab.tabId
            this.selectedTargetId = target.contents.id
            return
          }
        } catch (error) {
          probeErrors.push(
            `${tab.tabId}: ${error instanceof Error ? error.message : String(error)}`,
          )
          // The target list can race a webview being replaced. Continue with
          // the remaining live entries, then refresh the list if necessary.
        }
      }
      if (attempt + 1 < BIND_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, BIND_RETRY_MS))
      }
    }
    const detail = [
      `discovered ${discovered.length ? discovered.join(', ') : 'no targets'}`,
      ...(probeErrors.length ? [`probe errors: ${probeErrors.join('; ')}`] : []),
    ].join('; ')
    this.connected = false
    this.invalidateRefs()
    throw new Error(`agent-browser could not bind browser panel ${target.panelId} (${detail})`)
  }

  private async selectBound(target: RegisteredTarget): Promise<void> {
    if (target.agentTabId && this.selectedTargetId === target.contents.id) {
      try {
        // Unlike `tab`, eval preserves agent-browser's ref cache. The marker
        // also detects an expired daemon that auto-launched its own blank page.
        const evaluated = objectValue(await this.run([
          'eval',
          `globalThis[${JSON.stringify(TARGET_MARKER)}] ?? null`,
        ]))
        if (evaluated.result === target.token) return
      } catch {
        // Reconnect and bind below.
      }
      target.agentTabId = null
      this.connected = false
      this.invalidateRefs()
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!target.agentTabId) await this.bind(target)
      try {
        this.invalidateRefs()
        await this.run(['tab', target.agentTabId!])
        this.selectedTargetId = target.contents.id
        return
      } catch (error) {
        target.agentTabId = null
        // AGENT_BROWSER_IDLE_TIMEOUT_MS may have stopped the daemon. Its next
        // command auto-launches a blank browser, so force bind() to reconnect
        // to Cate's Electron endpoint before looking for this guest again.
        this.connected = false
        this.invalidateRefs()
        if (attempt === 1) throw error
      }
    }
  }

  private translateRef(target: RegisteredTarget, raw: unknown): string {
    if (typeof raw !== 'string' || !raw) throw new Error('ref-required')
    const ref = raw.startsWith('@') ? raw : `@${raw}`
    const upstream = target.refs.get(ref)
    if (!upstream) throw new Error('stale-ref')
    return upstream
  }

  private async boxFor(target: RegisteredTarget, raw: unknown): Promise<AgentBrowserResult['cursor'] | undefined> {
    if (raw === undefined) return undefined
    const ref = this.translateRef(target, raw)
    await this.run(['scrollintoview', ref])
    return this.boxForSelector(ref)
  }

  private async boxForSelector(selector: string): Promise<AgentBrowserResult['cursor'] | undefined> {
    const box = objectValue(await this.run(['get', 'box', selector]))
    if (![box.x, box.y, box.width, box.height].every((value) => typeof value === 'number')) return undefined
    const x = box.x as number
    const y = box.y as number
    const width = box.width as number
    const height = box.height as number
    return {
      x: x + width / 2,
      y: y + height / 2,
      rect: [x, y, width, height],
      label: '',
      kind: 'move',
    }
  }

  private async cursorForCommand(
    target: RegisteredTarget,
    command: string[],
  ): Promise<AgentBrowserResult['cursor'] | undefined> {
    if (!agentBrowserCommandShowsActivity(command)) return undefined
    if (command[0] === 'mouse' && command[1] === 'move') {
      const x = Number(command[2])
      const y = Number(command[3])
      if (Number.isFinite(x) && Number.isFinite(y)) {
        return { x, y, label: '', kind: 'move' }
      }
    }
    if (new Set([
      'check',
      'click',
      'dblclick',
      'drag',
      'fill',
      'focus',
      'hover',
      'scrollintoview',
      'select',
      'type',
      'uncheck',
    ]).has(command[0]) && command[1]) {
      if (/^@s\d+e\d+$/.test(command[1])) return this.boxFor(target, command[1])
      return this.boxForSelector(command[1])
    }
    return undefined
  }

  private async snapshotCommand(
    target: RegisteredTarget,
    command: string[],
  ): Promise<Record<string, unknown>> {
    const data = objectValue(await this.run(command))
    target.revision += 1
    target.refs.clear()
    const snapshotId = `s${target.revision}`
    const refs = objectValue(data.refs)
    const exposed: Array<{ ref: string; role: string; name: string }> = []
    for (const [key, raw] of Object.entries(refs)) {
      const upstream = `@${key}`
      const ref = `@${snapshotId}${key}`
      target.refs.set(ref, upstream)
      const metadata = objectValue(raw)
      exposed.push({
        ref,
        role: typeof metadata.role === 'string' ? metadata.role : '',
        name: typeof metadata.name === 'string' ? metadata.name : '',
      })
    }
    const snapshot = typeof data.snapshot === 'string'
      ? data.snapshot.replace(/\[ref=(e\d+)\]/g, (_match, ref: string) => `[ref=${snapshotId}${ref}]`)
      : ''
    return {
      snapshotId,
      url: typeof data.origin === 'string' ? data.origin : target.contents.getURL(),
      title: target.contents.getTitle(),
      refs: exposed,
      snapshot,
    }
  }

  private async snapshot(target: RegisteredTarget, args: BrowserArgs): Promise<Record<string, unknown>> {
    const command = ['snapshot']
    const selector = stringArg(args, 'selector')
    if (selector) command.push('--selector', selector)
    return this.snapshotCommand(target, command)
  }

  private translateCommandRefs(target: RegisteredTarget, command: string[]): string[] {
    return command.map((part) => /^@s\d+e\d+$/.test(part) ? this.translateRef(target, part) : part)
  }

  private async actionSelector(target: RegisteredTarget, raw: unknown): Promise<string> {
    const ref = this.translateRef(target, raw)
    const attribute = objectValue(await this.run(['get', 'attr', ref, 'id']))
    const id = attribute.value
    return typeof id === 'string' && id
      ? `[id=${JSON.stringify(id)}]`
      : ref
  }

  private pointer(cursor: AgentBrowserResult['cursor'] | undefined): { x: number; y: number } {
    if (!cursor || typeof cursor.x !== 'number' || typeof cursor.y !== 'number') {
      throw new Error('element-has-no-actionable-box')
    }
    return { x: cursor.x, y: cursor.y }
  }

  private async movePointer(cursor: AgentBrowserResult['cursor'] | undefined): Promise<unknown> {
    const { x, y } = this.pointer(cursor)
    return this.run(['mouse', 'move', String(Math.round(x)), String(Math.round(y))])
  }

  private async clickPointer(
    cursor: AgentBrowserResult['cursor'] | undefined,
    button = 'left',
  ): Promise<unknown> {
    await this.movePointer(cursor)
    await this.run(['mouse', 'down', button])
    return this.run(['mouse', 'up', button])
  }

  private async appendText(selector: string, text: string): Promise<unknown> {
    return this.evaluatePage(fillElementScript(selector, text, true))
  }

  private async fillSelector(selector: string, text: string): Promise<unknown> {
    return this.evaluatePage(fillElementScript(selector, text))
  }

  private async actOnSelector(selector: string, action: 'click' | 'dblclick' | 'focus' | 'hover'): Promise<unknown> {
    return this.evaluatePage(elementActionScript(selector, action))
  }

  private async evaluatePage(script: string): Promise<Record<string, unknown>> {
    const result = objectValue(objectValue(await this.run(['eval', script])).result)
    if (typeof result.error === 'string') throw new Error(result.error)
    return result
  }

  private async nativeCommand(
    target: RegisteredTarget,
    method: 'command' | 'readCommand',
    raw: unknown,
  ): Promise<AgentBrowserResult> {
    const command = validateAgentBrowserCommand(raw)
    if (method === 'readCommand' && !isReadOnlyAgentBrowserCommand(command)) {
      return { error: 'browser-command-requires-control' }
    }

    if (command[0] === 'snapshot') {
      return { result: await this.snapshotCommand(target, command) }
    }

    const cursor = await this.cursorForCommand(target, command)
    let translated = this.translateCommandRefs(target, command)

    // agent-browser 0.33 parses `--state visible` as its global storage-state
    // file option even after `wait`. Visibility is the selector wait's default,
    // so remove only that redundant spelling before invoking the native binary.
    if (translated[0] === 'wait') {
      if (typeof command[1] === 'string' && /^@s\d+e\d+$/.test(command[1])) {
        translated[1] = await this.actionSelector(target, command[1])
      }
      const stateIndex = translated.findIndex((part) => part === '--state' || part.startsWith('--state='))
      const state = stateIndex < 0
        ? undefined
        : translated[stateIndex] === '--state'
          ? translated[stateIndex + 1]
          : translated[stateIndex].slice('--state='.length)
      if (state === 'visible') {
        translated.splice(stateIndex, translated[stateIndex] === '--state' ? 2 : 1)
      }
    }

    if (translated[0] === 'screenshot') {
      const filePath = path.join(app.getPath('temp'), 'cate-screenshots', `screenshot-${Date.now()}.png`)
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
      const selector = translated.find((part) => /^@e\d+$/.test(part))
      const flags = translated.slice(1).filter((part) => part !== selector)
      translated = ['screenshot', ...(selector ? [selector] : []), filePath, ...flags]
      await this.run(translated)
      return { result: { path: filePath } }
    }

    let result: unknown
    const action = command[0]
    const revisionedRef = typeof command[1] === 'string' && /^@s\d+e\d+$/.test(command[1])
    if (revisionedRef && ['click', 'dblclick', 'focus', 'hover', 'fill', 'type'].includes(action)) {
      const selector = await this.actionSelector(target, command[1])
      if (!selector.startsWith('@') && action === 'fill' && command.length === 3) {
        result = await this.fillSelector(selector, command[2])
      } else if (!selector.startsWith('@') && action === 'type' && command.length === 3) {
        result = await this.appendText(selector, command[2])
      } else if (!selector.startsWith('@') && (action === 'click' || action === 'dblclick' || action === 'focus' || action === 'hover')) {
        result = await this.actOnSelector(selector, action)
      } else {
        result = await this.run(translated)
      }
    } else {
      result = await this.run(translated)
    }
    return {
      result,
      ...(agentBrowserCommandShowsActivity(command)
        ? {
            cursor: {
              ...cursor,
              label: agentBrowserActivityLabel(command),
              kind: cursorKind(command[0]),
            },
          }
        : {}),
    }
  }

  private locatorCommand(args: BrowserArgs, action: 'click' | 'fill' | 'check' | 'focus' | 'hover' | 'text', text?: string): string[] {
    const by = stringArg(args, 'by')
    const value = stringArg(args, 'value')
    if (!by || !value) throw new Error('ref-or-locator-required')
    if (by === 'css') {
      const nth = args.nth
      if (typeof nth === 'number') return ['find', 'nth', String(nth), value, action, ...(text === undefined ? [] : [text])]
      if (action === 'text') return ['get', 'text', value]
      return [action, value, ...(text === undefined ? [] : [text])]
    }
    const locator = by === 'altText' ? 'alt' : by
    if (!['role', 'text', 'label', 'placeholder', 'testid', 'alt', 'title'].includes(locator)) {
      throw new Error(`unsupported-locator:${by}`)
    }
    if (args.nth !== undefined) throw new Error('semantic-locator-nth-not-supported')
    return [
      'find',
      locator,
      value,
      action,
      ...(text === undefined ? [] : [text]),
      ...(boolArg(args, 'exact') ? ['--exact'] : []),
    ]
  }

  private async selectorOrLocator(
    target: RegisteredTarget,
    args: BrowserArgs,
    action: 'click' | 'fill' | 'check' | 'focus' | 'hover' | 'text',
    text?: string,
  ): Promise<string[]> {
    if (args.ref !== undefined) {
      const ref = this.translateRef(target, args.ref)
      if (action === 'text') return ['get', 'text', ref]
      return [action, ref, ...(text === undefined ? [] : [text])]
    }
    return this.locatorCommand(args, action, text)
  }

  private async executeBound(
    target: RegisteredTarget,
    method: string,
    args: BrowserArgs,
  ): Promise<AgentBrowserResult> {
    if (method === 'command' || method === 'readCommand') {
      return this.nativeCommand(target, method, args.command)
    }
    if (method === 'snapshot') return { result: await this.snapshot(target, args) }

    if (method === 'evaluate') {
      const expression = stringArg(args, 'expression')
      if (!expression) return { error: 'expression-required' }
      const data = objectValue(await this.run(['eval', expression]))
      return { result: { value: data.result ?? null } }
    }

    if (method === 'console' || method === 'consoleClear') {
      const data = objectValue(await this.run(['console', ...(method === 'consoleClear' ? ['--clear'] : [])]))
      return { result: method === 'consoleClear' ? undefined : data }
    }

    if (method === 'dialogPolicy') {
      const policy = stringArg(args, 'policy')
      if (policy !== 'accept' && policy !== 'dismiss') return { error: 'policy-required: accept|dismiss' }
      return {
        result: await this.run([
          'dialog',
          policy,
          ...(policy === 'accept' && stringArg(args, 'promptText') ? [stringArg(args, 'promptText')!] : []),
        ]),
      }
    }
    if (method === 'dialogs') return { result: await this.run(['dialog', 'status']) }

    if (method === 'inspect') {
      if (args.ref === undefined) {
        const inspected = await this.run(this.locatorCommand(args, 'text'))
        target.refs.clear()
        return { result: inspected }
      }
      const ref = this.translateRef(target, args.ref)
      const text = await this.run(['get', 'text', ref])
      const box = await this.run(['get', 'box', ref])
      const visible = await this.run(['is', 'visible', ref])
      const enabled = await this.run(['is', 'enabled', ref])
      const checked = await this.run(['is', 'checked', ref]).catch(() => ({}))
      return { result: { ref: args.ref, ...objectValue(text), ...objectValue(box), ...objectValue(visible), ...objectValue(enabled), ...objectValue(checked) } }
    }
    if (method === 'find') {
      const found = await this.run(this.locatorCommand(args, 'text'))
      target.refs.clear()
      return { result: found }
    }
    if (method === 'text') {
      const command = args.ref === undefined
        ? ['get', 'text', 'body']
        : ['get', 'text', this.translateRef(target, args.ref)]
      return { result: await this.run(command) }
    }
    if (method === 'attrs') {
      return { result: await this.run(['get', 'html', this.translateRef(target, args.ref)]) }
    }
    if (method === 'state') {
      const ref = this.translateRef(target, args.ref)
      const visible = await this.run(['is', 'visible', ref])
      const enabled = await this.run(['is', 'enabled', ref])
      const checked = await this.run(['is', 'checked', ref]).catch(() => ({}))
      return { result: { ...objectValue(visible), ...objectValue(enabled), ...objectValue(checked) } }
    }
    if (method === 'assets') {
      const data = objectValue(await this.run([
        'eval',
        `Array.from(document.images).slice(0,${Math.max(0, numberArg(args, 'max', 50))}).map(i=>({src:i.currentSrc||i.src,alt:i.alt,width:i.naturalWidth,height:i.naturalHeight}))`,
      ]))
      return { result: data.result ?? [] }
    }
    if (method === 'clipboardRead') {
      const data = objectValue(await this.run(['clipboard', 'read']))
      return { result: { text: typeof data.text === 'string' ? data.text : '' } }
    }
    if (method === 'clipboardWrite') {
      const text = stringArg(args, 'text')
      if (text === undefined) return { error: 'text-required' }
      await this.run(['clipboard', 'write', text])
      return { result: { ok: true } }
    }

    if (method === 'screenshot') {
      const mode = stringArg(args, 'mode')
      const filePath = path.join(app.getPath('temp'), 'cate-screenshots', `screenshot-${Date.now()}.png`)
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
      const command = ['screenshot']
      if (mode === 'element') command.push(this.translateRef(target, args.ref))
      command.push(filePath)
      if (mode === 'fullPage') command.push('--full')
      await this.run(command)
      return { result: { path: filePath } }
    }

    if (method === 'wait') {
      const condition = objectValue(args.condition)
      const timeout = Math.min(Math.max(numberArg(args, 'timeoutMs', 5_000), 1), 8_000)
      let command: string[]
      if (!condition.kind) command = ['wait', String(timeout)]
      else if (condition.kind === 'load') command = ['wait', '--load', 'load']
      else if (condition.kind === 'text') command = ['wait', '--text', String(condition.value)]
      else if (condition.kind === 'textGone') {
        command = ['wait', '--fn', `!document.body.innerText.includes(${JSON.stringify(String(condition.value))})`]
      } else if (condition.kind === 'url') command = ['wait', '--url', String(condition.value)]
      else {
        const selector = condition.kind === 'ref'
          ? this.translateRef(target, condition.ref)
          : String(condition.value)
        command = ['wait', selector, '--state', String(condition.state ?? 'visible')]
      }
      command.push('--timeout', String(timeout))
      await this.run(command)
      return {
        result: boolArg(args, 'includeSnapshot')
          ? { snapshot: await this.snapshot(target, {}) }
          : { url: target.contents.getURL(), title: target.contents.getTitle(), loading: target.contents.isLoading() },
      }
    }

    if (method === 'viewport') {
      if (boolArg(args, 'reset')) return { error: 'viewport-reset-not-supported' }
      const width = numberArg(args, 'width')
      const height = numberArg(args, 'height')
      if (width <= 0 || height <= 0) return { error: 'width-and-height-required' }
      await this.run(['set', 'viewport', String(width), String(height), String(numberArg(args, 'deviceScaleFactor', 1) || 1)])
      return { result: { width, height } }
    }

    const cursor = await this.boxFor(target, method === 'drag' ? args.ref ?? args.from : args.ref)
    if (Array.isArray(args.modifiers) && args.modifiers.length > 0) {
      return { error: 'agent-browser-pointer-modifiers-not-supported' }
    }
    const complete = async (result: unknown): Promise<AgentBrowserResult> => {
      if (args.by !== undefined && stringArg(args, 'by') !== 'css') target.refs.clear()
      return {
        result: boolArg(args, 'includeSnapshot')
          ? { ...objectValue(result), snapshot: await this.snapshot(target, {}) }
          : result,
        cursor: {
          ...cursor,
          label: targetLabel(method, args),
          kind: cursorKind(method),
        },
      }
    }
    const finish = async (command: string[]): Promise<AgentBrowserResult> => {
      return complete(await this.run(command))
    }

    if (method === 'click' || method === 'dblclick' || method === 'hover') {
      const action = method === 'dblclick' || numberArg(args, 'count', 1) === 2 ? 'dblclick' : method
      const button = stringArg(args, 'button') ?? 'left'
      if (button !== 'left') {
        if (action !== 'click' || !cursor || typeof cursor.x !== 'number' || typeof cursor.y !== 'number') {
          return { error: 'non-left-click-requires-ref' }
        }
        return complete(await this.clickPointer(cursor, button))
      }
      if (action === 'dblclick' && args.ref === undefined && stringArg(args, 'by') !== 'css') {
        return { error: 'double-click-requires-ref-or-css' }
      }
      if (args.ref !== undefined) {
        const selector = await this.actionSelector(target, args.ref)
        return selector.startsWith('@')
          ? finish([action, selector])
          : complete(await this.actOnSelector(selector, action))
      }
      if (action === 'dblclick') {
        return complete(await this.actOnSelector(stringArg(args, 'value')!, action))
      }
      if (stringArg(args, 'by') === 'css') {
        return complete(await this.actOnSelector(stringArg(args, 'value')!, action))
      }
      return finish(await this.selectorOrLocator(target, args, action, undefined))
    }
    if (method === 'fill') {
      const text = stringArg(args, 'text') ?? ''
      if (args.ref !== undefined) {
        const selector = await this.actionSelector(target, args.ref)
        return selector.startsWith('@')
          ? finish(['fill', selector, text])
          : complete(await this.fillSelector(selector, text))
      }
      const command = await this.selectorOrLocator(target, args, 'fill', text)
      if (stringArg(args, 'by') === 'css') {
        return complete(await this.fillSelector(stringArg(args, 'value')!, text))
      }
      return finish(command)
    }
    if (method === 'type') {
      if (args.ref !== undefined || stringArg(args, 'by') === 'css') {
        const text = stringArg(args, 'text') ?? ''
        if (args.ref !== undefined) {
          const selector = await this.actionSelector(target, args.ref)
          return selector.startsWith('@')
            ? finish(['type', selector, text])
            : complete(await this.appendText(selector, text))
        }
        return complete(await this.appendText(stringArg(args, 'value')!, text))
      }
      await this.run(this.locatorCommand(args, 'click'))
      return finish(['keyboard', 'type', stringArg(args, 'text') ?? ''])
    }
    if (method === 'press') {
      if (args.ref !== undefined || args.by !== undefined) {
        if (args.ref !== undefined) await this.run(['focus', await this.actionSelector(target, args.ref)])
        else await this.run(await this.selectorOrLocator(target, args, 'click'))
      }
      const key = stringArg(args, 'key')
      if (!key) return { error: 'key-required' }
      return finish(['press', key.replace(/^cmd\+/i, 'Meta+')])
    }
    if (method === 'focus') {
      if (args.ref !== undefined) {
        const selector = await this.actionSelector(target, args.ref)
        return selector.startsWith('@')
          ? finish(['focus', selector])
          : complete(await this.actOnSelector(selector, 'focus'))
      }
      return stringArg(args, 'by') === 'css'
          ? complete(await this.actOnSelector(stringArg(args, 'value')!, 'focus'))
          : finish(await this.selectorOrLocator(target, args, 'focus'))
    }
    if (method === 'select') {
      const values = Array.isArray(args.values) ? args.values.filter((value): value is string => typeof value === 'string') : []
      if (!values.length) return { error: 'value-required' }
      if (args.ref === undefined && stringArg(args, 'by') !== 'css') return { error: 'select-requires-ref-or-css' }
      const selector = args.ref !== undefined
        ? await this.actionSelector(target, args.ref)
        : stringArg(args, 'value')!
      return finish(['select', selector, ...values])
    }
    if (method === 'check' || method === 'uncheck') {
      if (args.ref !== undefined) {
        return finish([method, await this.actionSelector(target, args.ref)])
      }
      if (method === 'check') return finish(await this.selectorOrLocator(target, args, 'check'))
      if (args.ref === undefined && stringArg(args, 'by') !== 'css') return { error: 'uncheck-requires-ref-or-css' }
      const selector = args.ref !== undefined
        ? this.translateRef(target, args.ref)
        : stringArg(args, 'value')!
      return finish(['uncheck', selector])
    }
    if (method === 'drag') {
      return finish([
        'drag',
        await this.actionSelector(target, args.ref ?? args.from),
        await this.actionSelector(target, args.to),
      ])
    }
    if (method === 'scroll') {
      const to = stringArg(args, 'to')
      if (args.ref !== undefined) await this.run(['scrollintoview', this.translateRef(target, args.ref)])
      if (to === 'top' || to === 'bottom') return finish(['scroll', to === 'top' ? 'up' : 'down', '1000000'])
      return finish(['mouse', 'wheel', String(numberArg(args, 'dy')), String(numberArg(args, 'dx'))])
    }
    if (method === 'mouse') {
      const action = stringArg(args, 'action') ?? 'click'
      const x = numberArg(args, 'x', -1)
      const y = numberArg(args, 'y', -1)
      if (x < 0 || y < 0) return { error: 'x-and-y-required' }
      await this.run(['mouse', 'move', String(x), String(y)])
      if (action === 'move') return finish(['mouse', 'move', String(x), String(y)])
      const button = stringArg(args, 'button') ?? 'left'
      if (action === 'down' || action === 'up') return finish(['mouse', action, button])
      if (action === 'click') {
        await this.run(['mouse', 'down', button])
        return finish(['mouse', 'up', button])
      }
      if (action === 'drag') {
        const toX = numberArg(args, 'toX', -1)
        const toY = numberArg(args, 'toY', -1)
        if (toX < 0 || toY < 0) return { error: 'toX-and-toY-required' }
        await this.run(['mouse', 'down', button])
        await this.run(['mouse', 'move', String(toX), String(toY)])
        return finish(['mouse', 'up', button])
      }
      return { error: 'unsupported-mouse-action' }
    }

    return { error: 'unsupported' }
  }
}

export const agentBrowserService = new AgentBrowserService()
