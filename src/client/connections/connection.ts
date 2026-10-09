// One connection per open workspace runtime (12.1). It owns the rpc client,
// the typed runtime proxy, reconnecting with backoff and the connection state
// the UI shows. Only this object knows its transport: `dialLoopback` is where
// local and network differ, and callers never ask which one it is.

import {
  type AnyCapability,
  type ByteDuplex,
  type CapabilityProxy,
  type ClientFeature,
  type RuntimeProxy,
} from '@kernel/rpc/contract'
import { RpcClient, createCapabilityProxy, createRuntimeProxy, type RpcClientState } from '@kernel/rpc/client'
import { framePortOver, type ProtocolVersion } from '@kernel/rpc/contract'
import { nestedRefusalRoot } from '@runtime/daemon/contract'
import { FRAME_MODE, isUnpairedRefusal } from '@runtime/transports/contract'
import type { ClientIdentity } from './identity'
import { SessionSubscriptions, type SessionHandle } from './session'
import type { ConnectionKind, ConnectionTarget, ShellTransports } from './transports'
import { tunnelDuplex } from './tunnel'

export type ConnectionState =
  | { kind: 'connecting' }
  /** `stale`: the runtime runs another build of the same protocol than
   *  this app (an older install, or a checkout's runtime before
   *  `runtime:dev`); it is fully usable (7.10). */
  | { kind: 'connected'; stale?: { runtime: string | null; app: string } }
  /** `lastSeen` is when the runtime was last connected (null: never). */
  | { kind: 'offline'; lastSeen: number | null; retrying: boolean; error?: string }
  /** A different protocol major: nothing but `runtime.info` and
   *  `runtime.update` answers (7.10). */
  | { kind: 'incompatible'; runtimeVersion: string }
  /** Someone stopped the runtime on purpose: no reconnecting until
   *  `retryNow` (which starts it again where the transport can). */
  | { kind: 'stopped' }
  /** The runtime refused this client: an unknown or revoked device
   *  (`unpaired`), its folder overlapping the open workspace `nestedIn`, or
   *  another reason in `message`. */
  | { kind: 'refused'; message: string; nestedIn?: string; unpaired?: boolean }
  | { kind: 'closed' }

export interface Backoff {
  initialMs: number
  maxMs: number
  factor: number
}

export const DEFAULT_BACKOFF: Backoff = { initialMs: 250, maxMs: 30_000, factor: 2 }

export interface WorkspaceConnectionOptions {
  workspaceId: string
  target: ConnectionTarget
  transports: ShellTransports
  identity: ClientIdentity
  /** App version, sent in `hello`. */
  version: string
  /** The protocol this client speaks; default: `PROTOCOL`. */
  protocol?: ProtocolVersion
  /** App build: a runtime of another build connects as `stale`. */
  build?: string
  backoff?: Partial<Backoff>
  now?: () => number
  /** Defaults to every declared capability. */
  /** The capabilities of the runtime proxy (`RUNTIME_CAPABILITIES`). */
  capabilities: readonly AnyCapability[]
}

export class WorkspaceConnection {
  readonly workspaceId: string
  /** How it dials, for diagnostics (presence, e2e). Nothing outside this
   *  module branches on it: every workspace works the same over either. */
  readonly kind: ConnectionKind
  private _target: ConnectionTarget
  readonly rpc: RpcClient
  /** Typed proxy over every declared capability. Calls queue while offline. */
  readonly runtime: RuntimeProxy
  private readonly transports: ShellTransports
  readonly identity: ClientIdentity
  private readonly build: string | undefined
  private readonly backoff: Backoff
  private readonly now: () => number
  private readonly proxies = new Map<string, unknown>()
  private readonly sessions: SessionSubscriptions
  private readonly listeners = new Set<() => void>()
  private _state: ConnectionState = { kind: 'connecting' }
  private started = false
  private dialing = false
  private attempt = 0
  private lastSeen: number | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  /** The runtime said it is stopping on purpose. */
  private stopAnnounced = false

  constructor(opts: WorkspaceConnectionOptions) {
    this.workspaceId = opts.workspaceId
    this._target = opts.target
    this.kind = opts.target.kind
    this.transports = opts.transports
    this.identity = opts.identity
    this.build = opts.build
    this.backoff = { ...DEFAULT_BACKOFF, ...opts.backoff }
    this.now = opts.now ?? Date.now
    this.rpc = new RpcClient({
      version: opts.version,
      ...(opts.protocol ? { protocol: opts.protocol } : {}),
      identity: {
        client: {
          clientId: opts.identity.clientId,
          device: opts.identity.device,
          features: [...opts.identity.features],
        },
      },
      nextOpCounter: opts.identity.nextCounter,
    })
    this.runtime = createRuntimeProxy(this.rpc, opts.capabilities)
    this.rpc.onStateChange((state) => this.onRpcState(state))
    this.rpc.onReady(() => this.watchLifecycle())
    this.sessions = new SessionSubscriptions(this.runtime.session)
  }

  get clientId(): string { return this.identity.clientId }
  get target(): ConnectionTarget { return this._target }
  /** Dials `target` from the next attempt on: a paired runtime's addresses
   *  change with its network. Same kind only. */
  retarget(target: ConnectionTarget): void {
    if (target.kind === this.kind) this._target = target
  }
  /** Dialing starts the runtime when nothing answers (on this machine, or
   *  through a machine's bridge); a paired runtime is started only on its
   *  own machine. */
  get startsRuntime(): boolean { return this.kind !== 'network' }
  get state(): ConnectionState { return this._state }

  getState = (): ConnectionState => this._state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  clientHas(feature: ClientFeature): boolean {
    return this.identity.features.has(feature)
  }

  /** A typed proxy for a declaration outside the runtime proxy (tests, a
   *  capability being added). */
  proxy<C extends AnyCapability>(cap: C): CapabilityProxy<C> {
    let proxy = this.proxies.get(cap.name) as CapabilityProxy<C> | undefined
    if (!proxy) {
      proxy = createCapabilityProxy(this.rpc, cap)
      this.proxies.set(cap.name, proxy)
    }
    return proxy
  }

  /** Starts connecting. Calls made before this queue. */
  start(): void {
    if (this.started || this.closed) return
    this.started = true
    this.dial()
  }

  /** Skips the backoff wait, and retries after a refusal. */
  retryNow(): void {
    if (this.closed || !this.started) return
    if (this.rpc.state === 'ready' || this.rpc.state === 'connecting') return
    this.stopAnnounced = false
    this.attempt = 0
    this.dial()
  }

  /** After sleep or a network change, when a connection may be dead without
   *  knowing it: one that does not answer within `timeoutMs` is dropped and
   *  dialed again; one that is down is dialed at once. */
  async checkAlive(timeoutMs = 5000): Promise<void> {
    if (this.closed || !this.started) return
    if (this._state.kind !== 'connected') {
      if (this._state.kind === 'offline') this.retryNow()
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const answered = await Promise.race([
      this.runtime.runtime.info().then(() => true, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) }),
    ])
    clearTimeout(timer)
    if (!answered && !this.closed && this.rpc.state === 'ready') this.rpc.detach('The runtime stopped answering')
  }

  /** A pipe to `port` on the runtime's machine (12.3): a TCP connection on
   *  this machine, through the runtime's tunnel otherwise. */
  dialLoopback(port: number): Promise<ByteDuplex> {
    if (this.kind === 'local') return this.transports.dialLoopbackTcp(port)
    return tunnelDuplex(this.runtime.tunnel.connect({ port }))
  }

  /** The panel's session channel, shared by every subscriber of this
   *  connection. Survives reconnects (it restarts with a snapshot). */
  subscribeSession<S = unknown>(panelId: string): SessionHandle<S> {
    return this.sessions.acquire<S>(panelId)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.clearRetry()
    this.sessions.dispose()
    this.rpc.close('Workspace closed')
    this.setState({ kind: 'closed' })
    this.listeners.clear()
  }

  private dial(): void {
    if (this.closed || this.dialing) return
    this.clearRetry()
    this.dialing = true
    if (this._state.kind !== 'offline' && this._state.kind !== 'connecting') this.setState({ kind: 'connecting' })
    this.openPipe().then(
      (duplex) => {
        this.dialing = false
        if (this.closed) {
          duplex.close('Workspace closed')
          return
        }
        // The outcome arrives as rpc state changes.
        // A machine's bridge carries the runtime's local socket.
        this.rpc.attach(framePortOver(duplex, FRAME_MODE[this.kind === 'network' ? 'network' : 'local'])).catch(() => {})
      },
      (err: unknown) => {
        this.dialing = false
        if (this.closed) return
        this.scheduleRetry(err instanceof Error ? err.message : String(err))
      },
    )
  }

  private openPipe(): Promise<ByteDuplex> {
    const target = this.target
    if (target.kind === 'local') return this.transports.dialLocal(target.root)
    if (target.kind === 'machine') {
      if (!this.transports.dialMachine) return Promise.reject(new Error('This client cannot run commands on other machines'))
      return this.transports.dialMachine(target.machine, target.root)
    }
    if (!this.transports.dialNetwork) return Promise.reject(new Error('This client cannot reach network runtimes'))
    return this.transports.dialNetwork({ runtimeId: target.runtimeId, endpoints: target.endpoints })
  }

  private onRpcState(state: RpcClientState): void {
    if (this.closed) return
    switch (state) {
      case 'ready': {
        this.attempt = 0
        this.lastSeen = this.now()
        const runtime = this.rpc.remote?.build ?? null
        this.setState({ kind: 'connected', ...(this.build !== undefined && runtime !== this.build ? { stale: { runtime, app: this.build } } : {}) })
        return
      }
      case 'incompatible':
        this.setState({ kind: 'incompatible', runtimeVersion: this.rpc.remote?.version ?? 'unknown' })
        return
      case 'refused': {
        const error = this.rpc.remote?.error
        const nestedIn = nestedRefusalRoot(error?.data)
        this.setState({
          kind: 'refused',
          message: error?.message ?? 'Runtime refused the connection',
          ...(nestedIn ? { nestedIn } : {}),
          ...(isUnpairedRefusal(error?.data) ? { unpaired: true } : {}),
        })
        return
      }
      case 'disconnected':
        if (this._state.kind === 'connected') this.lastSeen = this.now()
        if (this.stopAnnounced) {
          this.setState({ kind: 'stopped' })
          return
        }
        this.scheduleRetry()
        return
      default:
        return
    }
  }

  /** Learns whether the runtime goes away on purpose; resubscribed on every
   *  hello (a runtime without the stream just never says). */
  private watchLifecycle(): void {
    this.stopAnnounced = false
    const lifecycle = this.runtime.runtime?.lifecycle
    if (!lifecycle) return
    const sub = lifecycle()
    sub.onEvent((event) => { if (event.kind === 'stopping' && event.reason === 'stop') this.stopAnnounced = true })
    sub.done.catch(() => {})
  }

  private scheduleRetry(error?: string): void {
    if (this.closed || this.retryTimer) return
    const { initialMs, maxMs, factor } = this.backoff
    const delay = Math.min(maxMs, initialMs * factor ** this.attempt)
    this.attempt++
    this.setState({ kind: 'offline', lastSeen: this.lastSeen, retrying: true, ...(error ? { error } : {}) })
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.dial()
    }, delay)
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private setState(state: ConnectionState): void {
    this._state = state
    for (const listener of [...this.listeners]) {
      try { listener() } catch { /* isolate listeners */ }
    }
  }
}
