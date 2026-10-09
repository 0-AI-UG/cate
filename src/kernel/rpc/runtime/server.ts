// The generic rpc server: serves registered capability implementations over
// any frame port. It knows no capability; dispatch comes from the
// declarations passed to `register`.

import {
  PROTOCOL,
  RpcError,
  isCompatible,
  knownFeatures,
  toWireError,
  type AnyCapability,
  type CallerHello,
  type ClientFeature,
  type EventOf,
  type Frame,
  type FramePort,
  type HelloMessage,
  type Message,
  type ParamsOf,
  type ProtocolVersion,
  type ReqMessage,
  type ResultOf,
  type WireError,
} from '../contract'
import { lifecycle as defaultLifecycle, type ClientConnection, type LifecycleBus } from '@kernel/lifecycle/runtime'

export interface ConnectionInfo {
  readonly id: number
  readonly peerVersion: string
  readonly protocol: ProtocolVersion
  /** Same protocol major. An incompatible peer may only call `crossMajor` methods. */
  readonly compatible: boolean
  readonly client: ClientConnection | null
  readonly caller: CallerHello | null
  has(feature: ClientFeature): boolean
}

export interface CallContext {
  readonly connection: ConnectionInfo
  readonly opId?: string
  /** Aborted when the caller cancels, the stream ends or the connection drops. */
  readonly signal: AbortSignal
}

export interface StreamSink<E, R = void> {
  emit(event: E): void
  /** Sends a binary chunk. Returns false once more than the window is
   *  unacknowledged: stop producing until `drain()` resolves. */
  bytes(chunk: Uint8Array): boolean
  drain(): Promise<void>
  /** Binary chunks the client writes to this stream. */
  onInput(listener: (bytes: Uint8Array) => void): void
  end(...result: R extends void ? [] | [R] : [R]): void
  fail(err: unknown): void
  readonly ended: boolean
}

type Cleanup = () => void

export type MethodHandler<Sp> = (params: ParamsOf<Sp>, ctx: CallContext) => ResultOf<Sp> | Promise<ResultOf<Sp>>
/** Starts a stream. It runs until the handler calls `end`/`fail` or the
 *  client cancels; a returned function runs when it stops. */
export type StreamHandler<Sp> = (
  params: ParamsOf<Sp>,
  sink: StreamSink<EventOf<Sp>, ResultOf<Sp>>,
  ctx: CallContext,
) => void | Cleanup | Promise<void | Cleanup>

export type CapabilityImpl<C extends AnyCapability> = {
  [K in keyof C['methods']]: MethodHandler<C['methods'][K]>
} & {
  [K in keyof C['streams']]: StreamHandler<C['streams'][K]>
}

export interface RpcServerOptions {
  /** Daemon release version, sent in `hello`. */
  version: string
  /** Daemon build, sent in `hello`. */
  build?: string
  protocol?: ProtocolVersion
  lifecycle?: LifecycleBus
  /** Throw (ideally an RpcError) to refuse a connection: bad token, device
   *  key that does not match the handshake. */
  acceptHello?: (hello: HelloMessage, connectionId: number) => void | Promise<void>
  /** Byte stream credit window. */
  window?: { high: number; low: number }
  /** How many recent op results are kept per client to answer resends. */
  opResultCache?: number
}

type Outcome = { result: unknown } | { error: WireError }

interface OpLog {
  highest: number
  recent: Map<number, Promise<Outcome>>
}

interface Registered {
  cap: AnyCapability
  impl: Record<string, (...args: never[]) => unknown>
}

const DEFAULT_WINDOW = { high: 1024 * 1024, low: 512 * 1024 }

export class RpcServer {
  private readonly caps = new Map<string, Registered>()
  private readonly conns = new Set<Connection>()
  private readonly ops = new Map<string, OpLog>()
  private nextConnId = 1
  readonly protocol: ProtocolVersion
  readonly lifecycle: LifecycleBus

  constructor(readonly opts: RpcServerOptions) {
    this.protocol = opts.protocol ?? PROTOCOL
    this.lifecycle = opts.lifecycle ?? defaultLifecycle
  }

  register<C extends AnyCapability>(cap: C, impl: CapabilityImpl<C>): () => void {
    if (this.caps.has(cap.name)) throw new Error(`Capability "${cap.name}" is already registered`)
    for (const name of [...Object.keys(cap.methods), ...Object.keys(cap.streams)]) {
      if (typeof (impl as Record<string, unknown>)[name] !== 'function') {
        throw new Error(`Capability "${cap.name}" has no handler for "${name}"`)
      }
    }
    const entry: Registered = { cap, impl: impl as Registered['impl'] }
    this.caps.set(cap.name, entry)
    return () => { if (this.caps.get(cap.name) === entry) this.caps.delete(cap.name) }
  }

  /** Serves one connection until its port closes. */
  serve(port: FramePort): void {
    const conn = new Connection(this, port, this.nextConnId++)
    this.conns.add(conn)
    port.onClose(() => {
      conn.teardown()
      this.conns.delete(conn)
    })
  }

  connections(): ConnectionInfo[] {
    return [...this.conns].filter((c) => c.info !== null).map((c) => c.info!)
  }

  close(reason = 'Runtime shutting down'): void {
    for (const conn of [...this.conns]) conn.port.close(reason)
  }

  /** @internal */
  lookup(capName: string, name: string): { kind: 'method' | 'stream'; crossMajor: boolean; fn: (...args: never[]) => unknown } | null {
    const entry = this.caps.get(capName)
    if (!entry) return null
    const own = (o: object) => Object.prototype.hasOwnProperty.call(o, name)
    // Implementations may be class instances, so keep `this`.
    const fn = (...args: never[]) => entry.impl[name].call(entry.impl, ...args)
    if (own(entry.cap.methods)) return { kind: 'method', crossMajor: entry.cap.methods[name].crossMajor, fn }
    if (own(entry.cap.streams)) return { kind: 'stream', crossMajor: false, fn }
    return null
  }

  /** @internal Runs `run` once per opId; a resend gets the first outcome. */
  dedupe(clientId: string, counter: number, run: () => Promise<Outcome>): Promise<Outcome> {
    let log = this.ops.get(clientId)
    if (!log) this.ops.set(clientId, (log = { highest: 0, recent: new Map() }))
    if (counter <= log.highest) {
      return log.recent.get(counter)
        ?? Promise.resolve({ error: toWireError(new RpcError('duplicate', `Op ${clientId}:${counter} was already handled`)) })
    }
    log.highest = counter
    const outcome = run()
    log.recent.set(counter, outcome)
    const limit = this.opts.opResultCache ?? 256
    for (const key of log.recent.keys()) {
      if (log.recent.size <= limit) break
      log.recent.delete(key)
    }
    return outcome
  }
}

interface StreamState {
  controller: AbortController
  cleanup: Cleanup | null
  outstanding: number
  drainWaiters: Array<() => void>
  input: ((bytes: Uint8Array) => void) | null
  /** Chunks that arrived before the handler set `onInput`. */
  early: Uint8Array[]
  ended: boolean
}

class Connection {
  info: ConnectionInfo | null = null
  private helloPending = false
  /** Messages that arrived while `acceptHello` was running. */
  private held: Frame[] | null = null
  private open = true
  private readonly inflight = new Map<number, AbortController>()
  private readonly streams = new Map<number, StreamState>()

  constructor(
    private readonly server: RpcServer,
    readonly port: FramePort,
    private readonly id: number,
  ) {
    port.onFrame((frame) => this.onFrame(frame))
  }

  private send(msg: Message): void {
    if (this.open) this.port.send({ kind: 'msg', msg })
  }

  private onFrame(frame: Frame): void {
    if (this.held) {
      this.held.push(frame)
      return
    }
    if (frame.kind === 'bytes') {
      const state = this.streams.get(frame.streamId)
      if (state?.input) state.input(frame.bytes)
      else state?.early.push(frame.bytes)
      return
    }
    const msg = frame.msg
    switch (msg.t) {
      case 'hello': void this.onHello(msg); return
      case 'req': this.onReq(msg); return
      case 'cancel': this.onCancel(msg.id); return
      case 'ack': this.onAck(msg.stream, msg.bytes); return
      default: return
    }
  }

  private async onHello(hello: HelloMessage): Promise<void> {
    if (this.info || this.helloPending) return
    this.helloPending = true
    this.held = []
    const refuse = (err: unknown) => {
      this.send({ t: 'hello', protocol: this.server.protocol, version: this.server.opts.version, build: this.server.opts.build, error: toWireError(err) })
      this.port.close('hello refused')
    }
    const client = hello.client
    const clientValid = client
      && typeof client.clientId === 'string' && client.clientId.length > 0 && !client.clientId.includes(':')
      && typeof client.device?.name === 'string' && typeof client.device?.keyFingerprint === 'string'
    const callerValid = hello.caller && typeof hello.caller.token === 'string'
    if (!Array.isArray(hello.protocol) || (!clientValid && !callerValid)) {
      refuse(new RpcError('rejected', 'Invalid hello'))
      return
    }
    try {
      await this.server.opts.acceptHello?.(hello, this.id)
    } catch (err) {
      refuse(err)
      return
    }
    const held = this.held
    this.held = null
    if (!this.open) return
    const features = clientValid ? knownFeatures(client.features) : []
    const clientConn: ClientConnection | null = clientValid
      ? { connectionId: this.id, clientId: client.clientId, device: { ...client.device }, features }
      : null
    const featureSet = new Set<ClientFeature>(features)
    this.info = {
      id: this.id,
      peerVersion: String(hello.version),
      protocol: [hello.protocol[0], hello.protocol[1]],
      compatible: isCompatible(hello.protocol, this.server.protocol),
      client: clientConn,
      caller: !clientValid && hello.caller ? { token: hello.caller.token } : null,
      has: (f) => featureSet.has(f),
    }
    this.send({ t: 'hello', protocol: this.server.protocol, version: this.server.opts.version, build: this.server.opts.build })
    if (clientConn && this.info.compatible) this.server.lifecycle.emitClientConnected(clientConn)
    for (const frame of held ?? []) this.onFrame(frame)
  }

  private onReq(req: ReqMessage): void {
    const reply = (outcome: Outcome) => {
      if (!this.inflight.delete(req.id)) return // cancelled
      this.send('error' in outcome ? { t: 'res', id: req.id, error: outcome.error } : { t: 'res', id: req.id, result: outcome.result })
    }
    const fail = (err: unknown) => this.send({ t: 'res', id: req.id, error: toWireError(err) })

    const info = this.info
    if (!info) return fail(new RpcError('rejected', 'hello first'))
    const target = this.server.lookup(req.cap, req.method)
    if (!target) return fail(new RpcError('unsupported', `${req.cap}.${req.method} is not supported by this runtime`))
    if (!info.compatible && !target.crossMajor) {
      return fail(new RpcError('unsupported', 'Incompatible protocol version'))
    }
    if (this.inflight.has(req.id) || this.streams.has(req.id)) return fail(new RpcError('rejected', 'Duplicate request id'))
    const params = req.params ?? undefined

    if (target.kind === 'stream') {
      this.startStream(req.id, target.fn, params, info)
      return
    }

    const controller = new AbortController()
    this.inflight.set(req.id, controller)
    const ctx: CallContext = { connection: info, signal: controller.signal, ...(req.opId ? { opId: req.opId } : {}) }
    // A handler starts in arrival order, like a stream: a stream opened right
    // after a method (a session subscribe after the op that adds the panel)
    // sees the method's synchronous effects.
    const run = (): Promise<Outcome> => {
      let out: unknown
      try {
        out = (target.fn as (p: unknown, c: CallContext) => unknown)(params, ctx)
      } catch (err) {
        return Promise.resolve({ error: toWireError(err) })
      }
      return Promise.resolve(out).then((result) => ({ result }), (err) => ({ error: toWireError(err) }))
    }

    if (req.opId !== undefined) {
      const counter = parseOpId(req.opId, info.client?.clientId)
      if (counter === null) {
        this.inflight.delete(req.id)
        return fail(new RpcError('rejected', `Invalid opId "${req.opId}"`))
      }
      void this.server.dedupe(info.client!.clientId, counter, run).then(reply)
      return
    }
    void run().then(reply)
  }

  private startStream(id: number, fn: (...args: never[]) => unknown, params: unknown, info: ConnectionInfo): void {
    const { high, low } = this.server.opts.window ?? DEFAULT_WINDOW
    const state: StreamState = {
      controller: new AbortController(),
      cleanup: null,
      outstanding: 0,
      drainWaiters: [],
      input: null,
      early: [],
      ended: false,
    }
    this.streams.set(id, state)
    const finish = (res: Message | null) => {
      if (state.ended) return
      state.ended = true
      this.streams.delete(id)
      if (res) this.send(res)
      this.stopStream(state)
    }
    const sink: StreamSink<unknown, unknown> = {
      emit: (data) => { if (!state.ended) this.send({ t: 'evt', stream: id, data }) },
      bytes: (chunk) => {
        if (state.ended) return false
        if (this.open) this.port.send({ kind: 'bytes', streamId: id, bytes: chunk })
        state.outstanding += chunk.length
        return state.outstanding <= high
      },
      drain: () => new Promise<void>((resolve) => {
        if (state.ended || state.outstanding <= low) resolve()
        else state.drainWaiters.push(resolve)
      }),
      onInput: (listener) => {
        if (state.ended) return
        state.input = listener
        for (const chunk of state.early.splice(0)) listener(chunk)
      },
      end: (result?: unknown) => finish({ t: 'res', id, result }),
      fail: (err) => finish({ t: 'res', id, error: toWireError(err) }),
      get ended() { return state.ended },
    }
    const ctx: CallContext = { connection: info, signal: state.controller.signal }
    const adopt = (cleanup: unknown) => {
      if (typeof cleanup !== 'function') return
      if (state.ended) runCleanup(cleanup as Cleanup)
      else state.cleanup = cleanup as Cleanup
    }
    try {
      const out = (fn as (p: unknown, s: StreamSink<unknown, unknown>, c: CallContext) => unknown)(params, sink, ctx)
      if (out instanceof Promise) out.then(adopt, (err) => sink.fail(err))
      else adopt(out)
    } catch (err) {
      sink.fail(err)
    }
  }

  private stopStream(state: StreamState): void {
    state.controller.abort()
    for (const resolve of state.drainWaiters.splice(0)) resolve()
    if (state.cleanup) runCleanup(state.cleanup)
    state.cleanup = null
    state.input = null
    state.early = []
  }

  private onCancel(id: number): void {
    const controller = this.inflight.get(id)
    if (controller) {
      this.inflight.delete(id)
      controller.abort()
      return
    }
    const stream = this.streams.get(id)
    if (stream) {
      stream.ended = true
      this.streams.delete(id)
      this.stopStream(stream)
    }
  }

  private onAck(id: number, bytes: number): void {
    const state = this.streams.get(id)
    if (!state || !(bytes > 0)) return
    state.outstanding = Math.max(0, state.outstanding - bytes)
    const { low } = this.server.opts.window ?? DEFAULT_WINDOW
    if (state.outstanding <= low) for (const resolve of state.drainWaiters.splice(0)) resolve()
  }

  teardown(): void {
    if (!this.open) return
    this.open = false
    for (const controller of this.inflight.values()) controller.abort()
    this.inflight.clear()
    for (const state of this.streams.values()) {
      state.ended = true
      this.stopStream(state)
    }
    this.streams.clear()
    const client = this.info?.client
    if (client && this.info?.compatible) this.server.lifecycle.emitClientGone(client)
  }
}

function runCleanup(cleanup: Cleanup): void {
  try { cleanup() } catch { /* a failing cleanup must not break the connection */ }
}

function parseOpId(opId: string, clientId: string | undefined): number | null {
  if (!clientId || !opId.startsWith(`${clientId}:`)) return null
  const counter = Number(opId.slice(clientId.length + 1))
  return Number.isSafeInteger(counter) && counter > 0 ? counter : null
}
