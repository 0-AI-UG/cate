// The generic rpc client. It outlives connections: calls made while
// disconnected are queued, calls in flight when a connection drops are resent
// on the next one (a mutating call keeps its opId, so the runtime applies it
// once), and streams marked `resume` are reopened.

import {
  CancelledError,
  ConnectionClosedError,
  IncompatibleProtocolError,
  PROTOCOL,
  RpcError,
  fromWireError,
  isCompatible,
  type CallOptions,
  type CallerHello,
  type ClientHello,
  type Frame,
  type FramePort,
  type HelloMessage,
  type Message,
  type ProtocolVersion,
  type ReqMessage,
  type SubscribeOptions,
  type Subscription,
} from '../contract'

export const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_HELLO_TIMEOUT_MS = 10_000

export type RpcClientState = 'disconnected' | 'connecting' | 'ready' | 'incompatible' | 'refused' | 'closed'

export interface RpcClientOptions {
  /** App version, sent in `hello`. */
  version: string
  /** Who this side is: a client (keeps `clientId` across reconnects) or a caller. */
  identity: { client: ClientHello } | { caller: CallerHello }
  protocol?: ProtocolVersion
  timeoutMs?: number
  helloTimeoutMs?: number
}

export interface CallSpec {
  mutates?: boolean
  timeoutMs?: number
  crossMajor?: boolean
}

export interface ReadyInfo {
  hello: HelloMessage
  /** A connection was ready before this one. */
  reconnect: boolean
}

interface PendingCall {
  req: ReqMessage
  crossMajor: boolean
  sent: boolean
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  cleanup: () => void
}

type Listener<T> = (value: T) => void

export class RpcClient {
  private port: FramePort | null = null
  private _state: RpcClientState = 'disconnected'
  private _remote: HelloMessage | null = null
  private everReady = false
  private nextId = 1
  private opCounter = 0
  private helloTimer: ReturnType<typeof setTimeout> | null = null
  private attachWaiter: { resolve: (h: HelloMessage) => void; reject: (e: Error) => void } | null = null
  private readonly calls = new Map<number, PendingCall>()
  private readonly streams = new Map<number, ClientStream>()
  private readonly readyListeners = new Set<Listener<ReadyInfo>>()
  private readonly stateListeners = new Set<Listener<RpcClientState>>()
  readonly protocol: ProtocolVersion

  constructor(private readonly opts: RpcClientOptions) {
    this.protocol = opts.protocol ?? PROTOCOL
  }

  get state(): RpcClientState { return this._state }
  /** The runtime's hello on the current or last connection. */
  get remote(): HelloMessage | null { return this._remote }
  get clientId(): string | null {
    return 'client' in this.opts.identity ? this.opts.identity.client.clientId : null
  }

  /** Runs after each successful hello, before queued and resent calls go out:
   *  the place to resync (send the last document sequence number). */
  onReady(listener: Listener<ReadyInfo>): () => void {
    this.readyListeners.add(listener)
    return () => { this.readyListeners.delete(listener) }
  }

  onStateChange(listener: Listener<RpcClientState>): () => void {
    this.stateListeners.add(listener)
    return () => { this.stateListeners.delete(listener) }
  }

  /** Starts a connection over `port`. Resolves with the runtime's hello; an
   *  incompatible runtime resolves too (state `incompatible`). */
  attach(port: FramePort): Promise<HelloMessage> {
    if (this._state === 'closed') return Promise.reject(new ConnectionClosedError('Client is closed'))
    const previous = this.port
    if (previous) {
      this.onDisconnect('replaced')
      previous.close('replaced')
    }
    this.port = port
    this.setState('connecting')
    const done = new Promise<HelloMessage>((resolve, reject) => { this.attachWaiter = { resolve, reject } })
    done.catch(() => {})
    port.onFrame((frame) => { if (this.port === port) this.onFrame(frame) })
    port.onClose((reason) => { if (this.port === port) this.onDisconnect(reason) })
    this.helloTimer = setTimeout(() => {
      if (this.port === port) port.close('Runtime handshake timed out')
    }, this.opts.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS)
    port.send({ kind: 'msg', msg: { t: 'hello', protocol: this.protocol, version: this.opts.version, ...this.opts.identity } })
    return done
  }

  /** Ends the current connection. Pending work stays queued for the next `attach`. */
  detach(reason = 'detached'): void {
    this.port?.close(reason)
  }

  /** Ends the client for good: every call and stream fails. */
  close(reason = 'Client closed'): void {
    if (this._state === 'closed') return
    this.setState('closed')
    const port = this.port
    this.port = null
    this.clearHello(new ConnectionClosedError(reason))
    port?.close(reason)
    this.failAll(() => new ConnectionClosedError(reason))
  }

  call(cap: string, method: string, params: unknown, spec: CallSpec = {}, opts: CallOptions = {}): Promise<unknown> {
    if (this._state === 'closed') return Promise.reject(new ConnectionClosedError('Client is closed'))
    const req: ReqMessage = { t: 'req', id: this.nextId++, cap, method }
    if (params !== undefined) req.params = params
    if (spec.mutates) {
      const clientId = this.clientId
      if (clientId) req.opId = `${clientId}:${++this.opCounter}`
    }
    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? spec.timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const timer = timeoutMs > 0
        ? setTimeout(() => this.settleCall(req.id, new RpcError('timeout', `${cap}.${method} timed out`), true), timeoutMs)
        : null
      const onAbort = () => this.settleCall(req.id, abortReason(opts.signal), true)
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      const call: PendingCall = {
        req,
        crossMajor: spec.crossMajor === true,
        sent: false,
        resolve,
        reject,
        cleanup: () => {
          if (timer) clearTimeout(timer)
          opts.signal?.removeEventListener('abort', onAbort)
        },
      }
      this.calls.set(req.id, call)
      if (opts.signal?.aborted) return onAbort()
      this.flushCall(call)
    })
  }

  subscribe(cap: string, name: string, params: unknown, opts: SubscribeOptions = {}): Subscription<unknown, unknown> {
    const stream = new ClientStream(this, cap, name, params, opts)
    if (this._state === 'closed') {
      stream.finish(new ConnectionClosedError('Client is closed'))
      return stream
    }
    if (opts.signal?.aborted) {
      stream.finish(abortReason(opts.signal))
      return stream
    }
    opts.signal?.addEventListener('abort', () => stream.cancel(), { once: true })
    this.startStream(stream)
    return stream
  }

  // ---- internals used by ClientStream ---------------------------------------

  /** @internal */
  sendFrame(frame: Frame): boolean {
    if (this._state !== 'ready' || !this.port) return false
    this.port.send(frame)
    return true
  }

  /** @internal */
  dropStream(stream: ClientStream, notifyRuntime: boolean): void {
    if (this.streams.get(stream.wireId) !== stream) return
    this.streams.delete(stream.wireId)
    if (notifyRuntime && stream.sent) this.sendFrame({ kind: 'msg', msg: { t: 'cancel', id: stream.wireId } })
  }

  private startStream(stream: ClientStream): void {
    stream.wireId = this.nextId++
    stream.sent = false
    this.streams.set(stream.wireId, stream)
    if (this._state === 'ready') this.sendStream(stream)
    else if (this._state === 'incompatible') stream.finish(this.incompatibleError())
    else if (this._state === 'refused') stream.finish(new ConnectionClosedError('Runtime refused the connection'))
  }

  private sendStream(stream: ClientStream): void {
    const req: ReqMessage = { t: 'req', id: stream.wireId, cap: stream.cap, method: stream.name }
    if (stream.params !== undefined) req.params = stream.params
    if (this.sendFrame({ kind: 'msg', msg: req })) {
      stream.sent = true
      stream.flushOutbox()
    }
  }

  private flushCall(call: PendingCall): void {
    if (call.sent) return
    if (this._state === 'incompatible' && !call.crossMajor) {
      this.settleCall(call.req.id, this.incompatibleError(), false)
      return
    }
    if (this._state === 'refused') {
      this.settleCall(call.req.id, new ConnectionClosedError('Runtime refused the connection'), false)
      return
    }
    if ((this._state === 'ready' || this._state === 'incompatible') && this.port) {
      this.port.send({ kind: 'msg', msg: call.req })
      call.sent = true
    }
  }

  private settleCall(id: number, outcome: Error | { result: unknown }, cancelRemote: boolean): void {
    const call = this.calls.get(id)
    if (!call) return
    this.calls.delete(id)
    call.cleanup()
    if (outcome instanceof Error) {
      if (cancelRemote && call.sent && this.port) this.port.send({ kind: 'msg', msg: { t: 'cancel', id } })
      call.reject(outcome)
    } else {
      call.resolve(outcome.result)
    }
  }

  private onFrame(frame: Frame): void {
    if (frame.kind === 'bytes') {
      this.streams.get(frame.streamId)?.deliverBytes(frame.bytes)
      return
    }
    const msg: Message = frame.msg
    switch (msg.t) {
      case 'hello': this.onHello(msg); return
      case 'res': {
        const stream = this.streams.get(msg.id)
        if (stream) {
          this.streams.delete(msg.id)
          stream.finish('error' in msg ? fromWireError(msg.error) : { result: msg.result })
          return
        }
        this.settleCall(msg.id, 'error' in msg ? fromWireError(msg.error) : { result: msg.result }, false)
        return
      }
      case 'evt': this.streams.get(msg.stream)?.deliverEvent(msg.data); return
      default: return
    }
  }

  private onHello(hello: HelloMessage): void {
    if (this._state !== 'connecting') return
    this._remote = hello
    if (hello.error) {
      const err = fromWireError(hello.error)
      this.setState('refused')
      this.clearHello(err)
      this.failAll(() => err)
      return
    }
    const compatible = isCompatible(hello.protocol, this.protocol)
    this.setState(compatible ? 'ready' : 'incompatible')
    const waiter = this.attachWaiter
    this.clearHello(null)
    waiter?.resolve(hello)
    if (compatible) {
      const info: ReadyInfo = { hello, reconnect: this.everReady }
      this.everReady = true
      for (const listener of [...this.readyListeners]) {
        try { listener(info) } catch { /* a listener must not block the queue */ }
      }
      for (const stream of [...this.streams.values()]) if (!stream.sent) this.sendStream(stream)
    } else {
      const err = this.incompatibleError()
      for (const stream of [...this.streams.values()]) stream.finish(err)
      this.streams.clear()
    }
    for (const call of [...this.calls.values()].sort((a, b) => a.req.id - b.req.id)) this.flushCall(call)
  }

  private onDisconnect(reason?: string): void {
    this.port = null
    this.clearHello(new ConnectionClosedError(reason ? `Runtime connection closed: ${reason}` : undefined))
    if (this._state === 'closed') return
    // A refusal stays visible until the next attach.
    if (this._state !== 'refused') this.setState('disconnected')
    for (const call of this.calls.values()) call.sent = false
    for (const stream of [...this.streams.values()]) {
      if (!stream.sent) continue
      this.streams.delete(stream.wireId)
      if (stream.resume) this.startStream(stream)
      else stream.finish(new ConnectionClosedError())
    }
  }

  private clearHello(err: Error | null): void {
    if (this.helloTimer) clearTimeout(this.helloTimer)
    this.helloTimer = null
    const waiter = this.attachWaiter
    this.attachWaiter = null
    if (waiter && err) waiter.reject(err)
  }

  private failAll(makeError: () => Error): void {
    for (const call of [...this.calls.values()]) this.settleCall(call.req.id, makeError(), false)
    for (const stream of [...this.streams.values()]) stream.finish(makeError())
    this.streams.clear()
  }

  private incompatibleError(): Error {
    const remote = this._remote
    return new IncompatibleProtocolError(this.protocol, remote?.protocol ?? [0, 0], remote?.version ?? 'unknown')
  }

  private setState(state: RpcClientState): void {
    if (this._state === state) return
    this._state = state
    for (const listener of [...this.stateListeners]) {
      try { listener(state) } catch { /* ignore */ }
    }
  }
}

class ClientStream implements Subscription<unknown, unknown> {
  wireId = 0
  sent = false
  readonly resume: boolean
  readonly done: Promise<unknown>
  private settled = false
  private resolveDone!: (value: unknown) => void
  private rejectDone!: (err: Error) => void
  private readonly eventListeners = new Set<Listener<unknown>>()
  private readonly byteListeners = new Set<Listener<Uint8Array>>()
  private readonly iterators = new Set<IteratorState>()
  private readonly outbox: Uint8Array[] = []

  constructor(
    private readonly client: RpcClient,
    readonly cap: string,
    readonly name: string,
    readonly params: unknown,
    private readonly opts: SubscribeOptions,
  ) {
    this.resume = opts.resume === true
    this.done = new Promise((resolve, reject) => {
      this.resolveDone = resolve
      this.rejectDone = reject
    })
    this.done.catch(() => {})
  }

  onEvent(listener: Listener<unknown>): () => void {
    this.eventListeners.add(listener)
    return () => { this.eventListeners.delete(listener) }
  }

  onBytes(listener: Listener<Uint8Array>): () => void {
    this.byteListeners.add(listener)
    return () => { this.byteListeners.delete(listener) }
  }

  write(bytes: Uint8Array): void {
    if (this.settled) return
    if (this.sent && this.client.sendFrame({ kind: 'bytes', streamId: this.wireId, bytes })) return
    this.outbox.push(bytes)
  }

  ack(bytes: number): void {
    if (this.settled || !this.sent || !(bytes > 0)) return
    this.client.sendFrame({ kind: 'msg', msg: { t: 'ack', stream: this.wireId, bytes } })
  }

  cancel(): void {
    if (this.settled) return
    this.client.dropStream(this, true)
    this.finish(new CancelledError())
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    const state: IteratorState = { queue: [], wake: null, ended: this.settled }
    this.iterators.add(state)
    const stop = () => {
      this.iterators.delete(state)
      state.ended = true
    }
    return {
      next: async () => {
        for (;;) {
          if (state.queue.length > 0) return { value: state.queue.shift(), done: false }
          if (state.ended || this.settled) {
            stop()
            if (state.error && !(state.error instanceof CancelledError)) throw state.error
            return { value: undefined, done: true }
          }
          await new Promise<void>((resolve) => { state.wake = resolve })
          state.wake = null
        }
      },
      return: async () => {
        stop()
        this.cancel()
        return { value: undefined, done: true }
      },
    }
  }

  /** @internal */
  flushOutbox(): void {
    for (const bytes of this.outbox.splice(0)) this.client.sendFrame({ kind: 'bytes', streamId: this.wireId, bytes })
  }

  /** @internal */
  deliverEvent(data: unknown): void {
    for (const listener of [...this.eventListeners]) {
      try { listener(data) } catch { /* ignore */ }
    }
    for (const it of this.iterators) {
      it.queue.push(data)
      it.wake?.()
    }
  }

  /** @internal */
  deliverBytes(bytes: Uint8Array): void {
    for (const listener of [...this.byteListeners]) {
      try { listener(bytes) } catch { /* ignore */ }
    }
    if (!this.opts.manualAck) this.ack(bytes.length)
  }

  /** @internal */
  finish(outcome: Error | { result: unknown }): void {
    if (this.settled) return
    this.settled = true
    this.outbox.length = 0
    if (outcome instanceof Error) this.rejectDone(outcome)
    else this.resolveDone(outcome.result)
    for (const it of this.iterators) {
      if (outcome instanceof Error) it.error = outcome
      it.wake?.()
    }
  }
}

interface IteratorState {
  queue: unknown[]
  wake: (() => void) | null
  ended: boolean
  error?: Error
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason
  return reason instanceof Error && reason.name !== 'AbortError' ? reason : new CancelledError()
}
