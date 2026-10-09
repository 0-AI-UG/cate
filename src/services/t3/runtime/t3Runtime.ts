// The T3 harness in the daemon: one `server` child per checkout of the
// workspace, started on demand, with its state in `<data>/t3/`. Clients load
// its UI at `http://127.0.0.1:<port>` through loopback routing; the runtime
// itself talks to it with the browser-session cookie it bootstraps.

import { randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLogger, type Logger } from '@kernel/log/contract'
import { RpcError } from '@kernel/rpc/contract'
import {
  RUNTIME_INSTALL_ROOT_PLACEHOLDER,
  RUNTIME_NODE_EXECUTABLE,
} from '@runtime/server/contract'
import type { ServerHost } from '@runtime/server/runtime'
import {
  canT3ThreadReceivePrompt,
  cleanProviderAuthOutput,
  PROVIDER_SETTINGS_PATCH_KEYS,
  providerAuthCode,
  providerAuthLaunch,
  providerAuthUrl,
  providerStatusFromSnapshot,
  t3ProviderModelsFromConfig,
  t3SnapshotBusy,
  t3ThreadActivity,
  T3_PROVIDERS,
  t3SettingsForClient,
  type T3CheckoutParams,
  type T3Conversation,
  type T3ConversationMessage,
  type T3HarnessStatus,
  type T3PanelParams,
  type T3PanelTarget,
  type T3ProviderAuthParams,
  type T3ProviderAuthSession,
  type T3ProviderModels,
  type T3ProviderSettings,
  type T3ProviderSettingsParams,
  type T3ProviderStatus,
  type T3ShellEvent,
  type T3ShellSnapshot,
  type T3StartThreadParams,
  type T3ThreadActivity,
} from '../contract'
import { t3Paths, type T3Paths } from './paths'
import { instanceSettings, prepareInstanceSettings, publishProviderProfile, readJsonObject, readProviderProbes } from './providerFiles'
import { settingsRpc } from './settingsRpc'
import { ThreadShellSubscription } from './threadShells'

const READY_PATH = '/.well-known/t3/environment'
const START_TIMEOUT_MS = 30_000
const FETCH_TIMEOUT_MS = 10_000
// How long a started turn blocks another send to its thread. The shell stream
// reports the running turn only after T3 emits it (plus a 100ms coalesce), and
// T3 does not reject a second thread.turn.start on a busy thread.
const TURN_START_HOLD_MS = 3_000
/** A freshly started harness opens its checkout's project shortly after it
 *  answers; a thread start polls for it this often. */
const PROJECT_POLL_MS = 250
/** A thread started outside T3's composer runs in T3's own default mode. */
const T3_DEFAULT_RUNTIME_MODE = 'full-access'
const DEFAULT_HARNESS = {
  node: RUNTIME_NODE_EXECUTABLE,
  entry: `${RUNTIME_INSTALL_ROOT_PLACEHOLDER}/t3/dist/bin.mjs`,
}

// ---- Dependencies -----------------------------------------------------------

export interface T3Pty {
  write(data: string): void
  kill(): void
}

/** Starts a pseudo terminal (services/terminal). */
export interface T3PtyHost {
  spawn(
    options: { file: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number },
    onData: (chunk: string) => void,
    onExit: (code: number) => void,
  ): T3Pty | Promise<T3Pty>
}

export interface TrustGate {
  isTrusted(): boolean
  requireTrusted(): void
}

export interface T3RuntimeDeps {
  /** Canonical workspace root. */
  root: string
  /** `<data>/t3`, from `dataPaths(dataDir).t3`. */
  t3Root: string
  trust: TrustGate
  /** Canonicalizes a checkout (the root when omitted) and refuses anything
   *  but the root or one of its worktree checkouts. */
  resolveCheckout(checkout: string | undefined): Promise<string>
  server: Pick<ServerHost, 'start' | 'stop'>
  pty: T3PtyHost
  /** Node binary and T3 entry. Default: the runtime's own Node and
   *  `t3/dist/bin.mjs` in its install dir. */
  harness?: { node: string; entry: string }
  /** The `cate` API socket and a token for one harness (like a terminal's). */
  cateSocket: string
  mintHarnessToken(checkout: string): string | Promise<string>
  /** Extra env for a starting harness (agents change capture); `id` is its
   *  instance id. `harnessStopped` runs once it exits or fails to start. */
  harnessEnv?(harness: { id: string; checkout: string }): Promise<Record<string, string>>
  harnessStopped?(id: string): void
  homeDir?: string
  fetch?: typeof fetch
  /** How long a thread start waits for T3 to open the checkout's project.
   *  Default 15s. */
  projectWaitMs?: number
  log?: Logger
}

// ---- State ------------------------------------------------------------------

interface Instance {
  checkout: string
  paths: T3Paths
  serverId: string
  port: number
  url: string
  environmentId: string
  /** `name=value` of T3's browser-session cookie. */
  cookie: string
  shells: ThreadShellSubscription
}

interface InstanceState {
  phase: T3HarnessStatus['phase']
  message?: string
  instance?: Instance
  start?: Promise<Instance>
  /** A restart or shutdown happened while starting: the result is discarded. */
  cancelled?: boolean
}

interface ProviderAuthState extends T3ProviderAuthSession {
  pty?: T3Pty
  rawOutput: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class T3Runtime {
  private readonly states = new Map<string, InstanceState>()
  /** A checkout's harness being stopped: the next start waits for its exit,
   *  so two harnesses never share one state directory. */
  private readonly stopping = new Map<string, Promise<void>>()
  /** Checkouts whose providers page was opened: their settings are published
   *  on shutdown in case the page never reported closing. */
  private readonly providerPages = new Set<string>()
  private readonly providerAuth = new Map<string, ProviderAuthState>()
  private readonly snapshots = new Map<string, T3ShellSnapshot>()
  private readonly listeners = new Set<(event: T3ShellEvent) => void>()
  /** Threads whose turn was just started, until the shell stream shows it. */
  private readonly startingTurns = new Set<string>()
  private readonly fetch: typeof fetch
  private readonly log: Logger
  private disposed = false

  constructor(private readonly deps: T3RuntimeDeps) {
    this.fetch = deps.fetch ?? fetch
    this.log = deps.log ?? createLogger('t3')
  }

  // ---- Harness lifecycle ----------------------------------------------------

  async panelUrl(params: T3PanelParams): Promise<T3PanelTarget> {
    const checkout = await this.checkout(params)
    this.deps.trust.requireTrusted()
    if (params.route === 'providers') this.providerPages.add(checkout)
    const instance = await this.ensureInstance(checkout)
    let url: string
    if (params.route === 'usage') url = `${instance.url}/usage`
    else if (params.route === 'providers') url = `${instance.url}/settings/providers`
    else if (params.threadId) url = `${instance.url}/${encodeURIComponent(instance.environmentId)}/${encodeURIComponent(params.threadId)}`
    else url = `${instance.url}/`
    const equals = instance.cookie.indexOf('=')
    return {
      url,
      port: instance.port,
      instanceId: instance.paths.instanceId,
      environmentId: instance.environmentId,
      threadId: params.threadId ?? null,
      session: { name: instance.cookie.slice(0, equals), value: instance.cookie.slice(equals + 1) },
    }
  }

  async status(params: T3CheckoutParams): Promise<T3HarnessStatus> {
    const state = this.states.get(await this.checkout(params))
    return state ? { phase: state.phase, ...(state.message ? { message: state.message } : {}) } : { phase: 'stopped' }
  }

  async restart(params: T3CheckoutParams): Promise<void> {
    await this.stopHarness(await this.checkout(params))
  }

  /** True while a turn runs in any harness or a provider sign-in is open. */
  busy(): boolean {
    for (const auth of this.providerAuth.values()) if (auth.phase === 'running') return true
    for (const snapshot of this.snapshots.values()) if (t3SnapshotBusy(snapshot)) return true
    return false
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const auth of this.providerAuth.values()) {
      if (auth.phase === 'running') auth.pty?.kill()
    }
    this.providerAuth.clear()
    await Promise.all([...this.providerPages].map((checkout) => this.publishFrom(checkout).catch((error) => {
      this.log.warn('failed to publish provider settings during shutdown: %s', errorMessage(error))
    })))
    await Promise.all([...this.states.keys()].map((checkout) => this.stopHarness(checkout)))
    this.listeners.clear()
  }

  private async checkout(params: T3CheckoutParams): Promise<string> {
    return this.deps.resolveCheckout(params.checkout)
  }

  private async ensureInstance(checkout: string): Promise<Instance> {
    if (this.disposed) throw new Error('The T3 harness is shutting down')
    const existing = this.states.get(checkout)
    if (existing?.instance && existing.phase === 'running') return existing.instance
    if (existing?.start) return existing.start

    const state: InstanceState = { phase: 'starting' }
    const previous = this.stopping.get(checkout) ?? Promise.resolve()
    const start = previous.then(() => this.startInstance(checkout, state)).then((instance) => {
      if (state.cancelled) {
        instance.shells.stop()
        void this.deps.server.stop(instance.serverId)
        throw new Error('The T3 harness start was cancelled')
      }
      state.phase = 'running'
      state.instance = instance
      state.start = undefined
      return instance
    }, (error: unknown) => {
      state.phase = 'error'
      state.message = errorMessage(error)
      state.start = undefined
      throw error
    })
    state.start = start
    this.states.set(checkout, state)
    return start
  }

  private async startInstance(checkout: string, state: InstanceState): Promise<Instance> {
    const paths = t3Paths(this.deps.t3Root, checkout)
    await fs.mkdir(paths.baseDir, { recursive: true, mode: 0o700 })
    await prepareInstanceSettings(paths)
    const token = await this.deps.mintHarnessToken(checkout)
    const bootstrapToken = randomBytes(24).toString('hex')
    const bootstrap = JSON.stringify({
      mode: 'desktop',
      noBrowser: true,
      // T3CODE_PORT takes precedence; the schema still requires a valid port.
      port: 3773,
      t3Home: paths.baseDir,
      host: '127.0.0.1',
      desktopBootstrapToken: bootstrapToken,
      tailscaleServeEnabled: false,
      tailscaleServePort: 3774,
    }) + '\n'

    let outputTail = ''
    let exited = false
    const harness = this.deps.harness ?? DEFAULT_HARNESS
    const released = () => this.deps.harnessStopped?.(paths.instanceId)
    let handle: Awaited<ReturnType<ServerHost['start']>>
    try {
      const extraEnv = (await this.deps.harnessEnv?.({ id: paths.instanceId, checkout })) ?? {}
      handle = await this.deps.server.start({
        command: [harness.node, harness.entry, '--bootstrap-fd', '0', '--auto-bootstrap-project-from-cwd'],
        cwd: checkout,
        env: {
          ...extraEnv,
          T3CODE_HOME: paths.baseDir,
          T3CODE_HOST: '127.0.0.1',
          T3CODE_NO_BROWSER: 'true',
          CATE_SOCKET: this.deps.cateSocket,
          CATE_TOKEN: token,
        },
        portEnv: 'T3CODE_PORT',
        readyPath: READY_PATH,
        readyTimeoutMs: START_TIMEOUT_MS,
        bootstrapStdin: bootstrap,
        includeCateCli: true,
      }, (_id, stream, chunk) => {
        outputTail = `${outputTail}${chunk}`.slice(-8192)
        if (stream === 'stderr') this.log.debug('[%s] %s', paths.instanceId, chunk.trimEnd())
      }, (id, code, signal) => {
        exited = true
        released()
        if (!state.instance || state.instance.serverId !== id) return
        state.phase = 'error'
        state.message = `T3 exited (code ${code ?? 'unknown'}, signal ${signal ?? 'none'})${outputTail.trim() ? `: ${outputTail.trim().slice(-500)}` : ''}`
        this.log.warn('server exited instance=%s code=%s signal=%s', paths.instanceId, code ?? 'unknown', signal ?? 'none')
        state.instance.shells.stop()
        state.instance = undefined
      })
    } catch (error) {
      released()
      throw error
    }

    const url = `http://127.0.0.1:${handle.port}`
    try {
      const environmentId = await this.readEnvironmentId(url)
      const cookie = await this.bootstrapSession(url, bootstrapToken)
      const shells = new ThreadShellSubscription({
        instanceId: paths.instanceId,
        checkout,
        url,
        cookie,
        alive: () => !exited && !state.cancelled,
      }, (snapshot) => this.publishShells(snapshot))
      this.log.info('running instance=%s pid=%d port=%d', paths.instanceId, handle.pid, handle.port)
      return { checkout, paths, serverId: handle.id, port: handle.port, url, environmentId, cookie, shells }
    } catch (error) {
      await this.deps.server.stop(handle.id)
      throw error
    }
  }

  private async readEnvironmentId(url: string): Promise<string> {
    const response = await this.fetch(`${url}${READY_PATH}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`T3 environment descriptor returned HTTP ${response.status}`)
    const body: unknown = await response.json()
    const environmentId = body && typeof body === 'object' ? (body as { environmentId?: unknown }).environmentId : undefined
    if (typeof environmentId !== 'string' || environmentId.length === 0) {
      throw new Error('T3 environment descriptor did not include an environment ID')
    }
    return environmentId
  }

  /** Exchanges the bootstrap token for T3's browser-session cookie. */
  private async bootstrapSession(url: string, bootstrapToken: string): Promise<string> {
    const response = await this.fetch(`${url}/api/auth/browser-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential: bootstrapToken }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`T3 browser session bootstrap returned HTTP ${response.status}`)
    const setCookie = response.headers.get('set-cookie')
    if (!setCookie) throw new Error('T3 browser session bootstrap returned no cookie')
    const pair = setCookie.split(';', 1)[0]
    if (pair.indexOf('=') <= 0) throw new Error('T3 browser session cookie was malformed')
    return pair
  }

  private stopHarness(checkout: string): Promise<void> {
    const state = this.states.get(checkout)
    if (!state) return this.stopping.get(checkout) ?? Promise.resolve()
    this.states.delete(checkout)
    state.cancelled = true
    const stopped = (async () => {
      const instance = state.instance ?? (state.start ? await state.start.catch(() => undefined) : undefined)
      state.instance = undefined
      if (!instance) return
      instance.shells.stop()
      await this.deps.server.stop(instance.serverId)
    })().finally(() => { if (this.stopping.get(checkout) === stopped) this.stopping.delete(checkout) })
    this.stopping.set(checkout, stopped)
    return stopped
  }

  // ---- Thread shells ---------------------------------------------------------

  private publishShells(snapshot: T3ShellSnapshot): void {
    this.snapshots.set(snapshot.instanceId, snapshot)
    this.emit({ kind: 'snapshot', snapshot })
  }

  private emit(event: T3ShellEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  /** Current snapshots, then every change, until the returned function runs. */
  watchThreadShells(listener: (event: T3ShellEvent) => void): () => void {
    for (const snapshot of this.snapshots.values()) listener({ kind: 'snapshot', snapshot })
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async threadActivity(params: T3CheckoutParams & { threadId: string }): Promise<{ activity: T3ThreadActivity; canReceivePrompt: boolean } | null> {
    const checkout = await this.checkout(params)
    const snapshot = [...this.snapshots.values()].find((candidate) => candidate.checkout === checkout)
    const thread = snapshot?.connected ? snapshot.threads[params.threadId] : undefined
    return thread ? { activity: t3ThreadActivity(thread), canReceivePrompt: canT3ThreadReceivePrompt(thread) } : null
  }

  // ---- Providers --------------------------------------------------------------

  async providerAuthStart(params: T3ProviderAuthParams): Promise<T3ProviderAuthSession> {
    const checkout = await this.checkout(params)
    this.deps.trust.requireTrusted()
    // The provider profile holds the binary and home directory T3 launches the
    // provider with; sign-in must write credentials there too.
    const profile = await readJsonObject(t3Paths(this.deps.t3Root, checkout).providerProfile, 'T3 provider profile')
    const { command, env } = providerAuthLaunch(params.providerId, profile, this.deps.homeDir ?? os.homedir(), params.provider)
    const id = `provider-auth-${randomUUID()}`
    const state: ProviderAuthState = { id, providerId: params.providerId, phase: 'running', output: '', rawOutput: '' }
    this.providerAuth.set(id, state)
    try {
      const pty = await this.deps.pty.spawn({
        file: command.executable,
        args: command.args,
        cwd: checkout,
        env: { ...env, TERM: 'xterm-256color' },
        cols: 96,
        rows: 30,
      }, (chunk) => {
        state.rawOutput = `${state.rawOutput}${chunk}`.slice(-32_768)
        state.output = cleanProviderAuthOutput(state.rawOutput).slice(-24_000)
        state.url = providerAuthUrl(state.rawOutput)
        state.code = providerAuthCode(state.rawOutput)
      }, (exitCode) => {
        if (state.phase !== 'running') return
        state.phase = exitCode === 0 ? 'succeeded' : 'failed'
        state.message = exitCode === 0
          ? 'Sign-in completed.'
          : state.output.trim()
            ? `Sign-in exited with code ${exitCode}.`
            : 'Sign-in could not start. Make sure the provider CLI is installed on this runtime.'
      })
      state.pty = pty
      if (state.phase === 'cancelled' || this.providerAuth.get(id) !== state) pty.kill()
      return this.authSnapshot(state)
    } catch (error) {
      this.providerAuth.delete(id)
      throw new Error(`Could not start ${params.providerId} sign-in: ${errorMessage(error)}`)
    }
  }

  providerAuthGet(id: string): T3ProviderAuthSession {
    return this.authSnapshot(this.auth(id))
  }

  providerAuthWrite(id: string, data: string): void {
    const state = this.auth(id)
    if (state.phase !== 'running') throw new RpcError('rejected', 'Provider sign-in is not running')
    if (data.length > 256) throw new RpcError('rejected', 'Provider sign-in input is too long')
    if (!state.pty) throw new RpcError('rejected', 'Provider sign-in is still starting')
    state.pty.write(data)
  }

  providerAuthCancel(id: string): void {
    const state = this.auth(id)
    if (state.phase !== 'running') return
    state.phase = 'cancelled'
    state.message = 'Sign-in cancelled.'
    state.pty?.kill()
  }

  private auth(id: string): ProviderAuthState {
    const state = this.providerAuth.get(id)
    if (!state) throw new RpcError('gone', 'Provider sign-in session was not found')
    return state
  }

  private authSnapshot(state: ProviderAuthState): T3ProviderAuthSession {
    return {
      id: state.id,
      providerId: state.providerId,
      phase: state.phase,
      output: state.output,
      ...(state.url ? { url: state.url } : {}),
      ...(state.code ? { code: state.code } : {}),
      ...(state.message ? { message: state.message } : {}),
    }
  }

  async providerStatuses(): Promise<T3ProviderStatus[]> {
    const probes = await readProviderProbes(this.instancesRoot())
    return T3_PROVIDERS.map(({ providerId, driverId }) =>
      providerStatusFromSnapshot(providerId, probes.find((probe) => probe.instanceId === driverId) ?? null))
  }

  async providerSettings(params: T3ProviderSettingsParams): Promise<T3ProviderSettings> {
    if (params.operation === 'read') {
      const { next } = await instanceSettings(t3Paths(this.deps.t3Root, await this.checkout(params)))
      return { settings: t3SettingsForClient(next), providers: await readProviderProbes(this.instancesRoot()) }
    }
    const instance = await this.trustedInstance(params)
    const call = (method: string, payload: unknown = {}) => settingsRpc(instance.url, instance.cookie, method, payload)
    if (params.operation === 'save') {
      const patch = params.patch ?? {}
      if (Object.keys(patch).some((field) => !PROVIDER_SETTINGS_PATCH_KEYS.has(field))) {
        throw new RpcError('rejected', 'Unsupported agent setting')
      }
      await call('server.updateSettings', { patch })
      await this.publishFrom(instance.checkout)
    } else if (params.operation === 'refresh') {
      await call('server.refreshProviders', {})
    } else if (params.operation === 'update') {
      await call('server.updateProvider', { provider: params.provider, instanceId: params.instanceId })
    } else {
      throw new RpcError('rejected', 'Invalid provider operation')
    }
    const config = await call('server.getConfig')
    return { settings: config.settings, providers: config.providers }
  }

  /** Read from T3's probe caches, so choosing a provider starts no harness;
   *  the thread started on it does. */
  async providerModels(): Promise<T3ProviderModels[]> {
    return t3ProviderModelsFromConfig(await readProviderProbes(this.instancesRoot()))
  }

  private instancesRoot(): string {
    return path.join(this.deps.t3Root, 'instances')
  }

  async publishProviderProfile(params: T3CheckoutParams): Promise<void> {
    await this.publishFrom(await this.checkout(params))
  }

  /** Publishes `checkout`'s provider settings and applies them to the other
   *  running instances (T3 reads its settings file on change). */
  private async publishFrom(checkout: string): Promise<void> {
    const source = this.states.get(checkout)?.instance
    if (!source) return
    if (!await publishProviderProfile(source.paths)) return
    await Promise.all([...this.states.values()]
      .map((state) => state.instance)
      .filter((instance): instance is Instance => Boolean(instance && instance.checkout !== checkout))
      .map((instance) => prepareInstanceSettings(instance.paths)))
  }

  // ---- Conversations ---------------------------------------------------------

  async conversations(params: T3CheckoutParams): Promise<T3Conversation[]> {
    const response = await this.harnessFetch(params, '/api/orchestration/shell')
    if (!response.ok) throw new Error(`T3 conversations returned HTTP ${response.status}`)
    const snapshot = await response.json() as { threads: Array<{ id: string; title: string; updatedAt: string }> }
    return snapshot.threads.map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
  }

  /** A thread's visible user and assistant messages, from T3's thread API. */
  async readConversation(params: T3CheckoutParams & { threadId: string }): Promise<T3ConversationMessage[] | null> {
    const response = await this.harnessFetch(params, `/api/orchestration/threads/${encodeURIComponent(params.threadId)}`)
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`T3 conversation returned HTTP ${response.status}`)
    const snapshot = await response.json() as { thread: { messages: Array<{ role: string; text: string; createdAt: string; streaming?: boolean }> } }
    return snapshot.thread.messages.flatMap(({ role, text, createdAt, streaming }) =>
      (role === 'user' || role === 'assistant') && text ? [{ role, text, createdAt, ...(streaming ? { streaming: true as const } : {}) }] : [])
  }

  async renameConversation(params: T3CheckoutParams & { threadId: string; title: string }): Promise<void> {
    const title = params.title.trim()
    if (!title) throw new RpcError('rejected', 'title is required')
    await this.dispatch(params, { type: 'thread.meta.update', threadId: params.threadId, title })
  }

  async deleteConversation(params: T3CheckoutParams & { threadId: string }): Promise<void> {
    const instance = await this.dispatch(params, { type: 'thread.delete', threadId: params.threadId })
    this.emit({ kind: 'deleted', instanceId: instance.paths.instanceId, threadId: params.threadId })
  }

  /** Submits a user turn to an existing thread as T3's composer would: the
   *  thread's own runtime mode and model, default interaction mode. */
  async startTurn(params: T3CheckoutParams & { threadId: string; text: string }): Promise<void> {
    if (!params.text.trim()) throw new RpcError('rejected', 'text is required')
    if (this.startingTurns.has(params.threadId)) throw new RpcError('rejected', 'agent-busy')
    this.startingTurns.add(params.threadId)
    try {
      await this.dispatchTurn(params)
    } catch (error) {
      this.startingTurns.delete(params.threadId)
      throw error
    }
    setTimeout(() => this.startingTurns.delete(params.threadId), TURN_START_HOLD_MS).unref?.()
  }

  /** Stops the thread's running turn, as T3's stop button does. */
  async interruptTurn(params: T3CheckoutParams & { threadId: string }): Promise<void> {
    await this.dispatch(params, { type: 'thread.turn.interrupt', threadId: params.threadId, createdAt: new Date().toISOString() })
  }

  /** A new thread on `instanceId` and `model` in the checkout's project, with
   *  its first turn, in one command (T3's composer bootstrap). */
  async startThread(params: T3StartThreadParams): Promise<{ threadId: string }> {
    const text = params.text.trim()
    if (!text) throw new RpcError('rejected', 'text is required')
    const project = await this.project(params)
    const threadId = randomUUID()
    const createdAt = new Date().toISOString()
    const modelSelection = { instanceId: params.instanceId, model: params.model }
    // A turn's `bootstrap` is run by T3's WebSocket dispatch only; over HTTP
    // the thread is created first, as that bootstrap does.
    await this.dispatch(params, {
      type: 'thread.create',
      threadId,
      projectId: project.id,
      title: text.slice(0, 80),
      modelSelection,
      runtimeMode: T3_DEFAULT_RUNTIME_MODE,
      interactionMode: 'default',
      branch: null,
      worktreePath: null,
      createdAt,
    })
    await this.dispatch(params, {
      type: 'thread.turn.start',
      threadId,
      message: { messageId: randomUUID(), role: 'user', text, attachments: [] },
      modelSelection,
      titleSeed: text.slice(0, 80),
      runtimeMode: T3_DEFAULT_RUNTIME_MODE,
      interactionMode: 'default',
      createdAt,
    })
    return { threadId }
  }

  /** The checkout's T3 project, once the harness (started here if needed)
   *  has opened it. */
  private async project(params: T3CheckoutParams): Promise<{ id: string }> {
    const checkout = path.resolve(await this.checkout(params))
    const deadline = Date.now() + (this.deps.projectWaitMs ?? 15_000)
    for (;;) {
      const response = await this.harnessFetch(params, '/api/orchestration/shell')
      if (!response.ok) throw new Error(`T3 projects returned HTTP ${response.status}`)
      const shell = await response.json() as { projects: Array<{ id: string; workspaceRoot: string }> }
      const project = shell.projects.find((candidate) => path.resolve(candidate.workspaceRoot) === checkout)
      if (project) return project
      if (Date.now() >= deadline) throw new RpcError('rejected', 't3-project-not-found')
      await new Promise((resolve) => setTimeout(resolve, PROJECT_POLL_MS))
    }
  }

  private async dispatchTurn(params: T3CheckoutParams & { threadId: string; text: string }): Promise<void> {
    const detail = await this.harnessFetch(params, `/api/orchestration/threads/${encodeURIComponent(params.threadId)}?turnLimit=1`)
    if (!detail.ok) throw new Error(`T3 conversation returned HTTP ${detail.status}`)
    const { thread } = await detail.json() as { thread: { runtimeMode: string } }
    await this.dispatch(params, {
      type: 'thread.turn.start',
      threadId: params.threadId,
      message: { messageId: randomUUID(), role: 'user', text: params.text, attachments: [] },
      runtimeMode: thread.runtimeMode,
      interactionMode: 'default',
      createdAt: new Date().toISOString(),
    })
  }

  private async dispatch(params: T3CheckoutParams, command: Record<string, unknown>): Promise<Instance> {
    const instance = await this.trustedInstance(params)
    const response = await this.request(instance, '/api/orchestration/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...command, commandId: randomUUID() }),
    })
    if (!response.ok) throw new Error(`T3 conversation update returned HTTP ${response.status}`)
    return instance
  }

  private async harnessFetch(params: T3CheckoutParams, route: string): Promise<Response> {
    return this.request(await this.trustedInstance(params), route)
  }

  private async trustedInstance(params: T3CheckoutParams): Promise<Instance> {
    const checkout = await this.checkout(params)
    this.deps.trust.requireTrusted()
    return this.ensureInstance(checkout)
  }

  private request(instance: Instance, route: string, init: RequestInit = {}): Promise<Response> {
    return this.fetch(`${instance.url}${route}`, {
      ...init,
      headers: { ...init.headers as Record<string, string>, Cookie: instance.cookie },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  }
}

export function createT3Runtime(deps: T3RuntimeDeps): T3Runtime {
  return new T3Runtime(deps)
}
