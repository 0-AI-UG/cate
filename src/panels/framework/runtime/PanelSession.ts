// The runtime panel session (architecture 11.2): owns a panel's live
// execution and state, keeps working with no client connected, publishes a
// plain JSON snapshot, handles typed ops and `cate.<type>.*` methods, and
// persists its own state through the kit.

import type { SessionApiHandler } from '@kernel/api/contract'
import type { Logger } from '@kernel/log/contract'
import { RpcError } from '@kernel/rpc/contract'
import type { Json, JsonObject, PanelId, PanelRecord } from '@workspace/document/contract'
import type { DocumentService } from '@workspace/document/runtime'

/** Where an op came from: a client connection, or the runtime itself (the
 *  `cate` API, another session). */
export interface OpContext {
  clientId: string | null
  connectionId: number | null
}

export interface SessionStore {
  read(): Json | undefined
  /** Debounced atomic write to `<data>/sessions/<panelId>.json`. */
  write(value: Json): void
  flush(): Promise<void>
}

export interface SurfaceCallOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

/** What the host hands a session. */
export interface SessionKit {
  readonly panelId: PanelId
  readonly document: DocumentService
  readonly store: SessionStore
  readonly log: Logger
  /** Runs a page operation on the driving client (10.2). */
  surface(op: string, args: unknown, options?: SurfaceCallOptions): Promise<unknown>
  /** Another panel's session, for cross-panel work. */
  session(panelId: PanelId): PanelSession | undefined
}

/** Receives a session's channel; the host adapts it to a stream sink. */
export interface SessionSubscriber {
  snapshot(rev: number, snapshot: JsonObject): void
  change(rev: number, change: JsonObject): void
  bytes(chunk: Uint8Array): void
  /** The session was disposed. */
  gone(): void
}

export type DisposeReason = 'removed' | 'replaced' | 'shutdown'

type OpKind<Op> = Op extends { kind: infer K extends string } ? K : never
export type OpHandlers<Op> = {
  [K in OpKind<Op>]: (op: Extract<Op, { kind: K }>, ctx: OpContext) => unknown
}

export abstract class PanelSession<S extends JsonObject = JsonObject, Op = never> {
  private rev = 0
  private readonly subscribers = new Set<SessionSubscriber>()
  protected state: S
  protected disposed = false
  record: PanelRecord
  /** The op handlers, keyed by op `kind`. */
  protected readonly ops = {} as OpHandlers<Op>
  /** Serves the type's `cate.<type>.*` session methods (`sessionApi`). */
  handleApi?: SessionApiHandler

  /** Side-effect free: work starts in `start()`. */
  constructor(protected readonly kit: SessionKit, record: PanelRecord, initial: S) {
    this.record = record
    this.state = initial
  }

  get panelId(): PanelId { return this.record.id }
  get isDisposed(): boolean { return this.disposed }
  snapshot(): S { return this.state }

  start(): void | Promise<void> {}

  /** The panel's record changed. Records are state, never commands: follow
   *  it, never kill or restart a resource because of it. */
  updateRecord(record: PanelRecord): void {
    const previous = this.record
    this.record = record
    this.recordChanged(previous)
  }

  protected recordChanged(_previous: PanelRecord): void {}

  /** Called before the panel is closed. Throw `RpcError('dirty')` for work
   *  that would be lost unless `discard`. */
  prepareClose(_options: { discard: boolean }): void | Promise<void> {}

  async handleOp(op: unknown, ctx: OpContext): Promise<unknown> {
    if (this.disposed) throw new RpcError('gone', `panel ${this.panelId} is gone`)
    const kind = (op as { kind?: unknown } | null)?.kind
    const handler = typeof kind === 'string' && Object.prototype.hasOwnProperty.call(this.ops, kind)
      ? (this.ops as Record<string, (op: unknown, ctx: OpContext) => unknown>)[kind]
      : undefined
    if (!handler) throw new RpcError('rejected', `${this.record.type} has no op "${String(kind)}"`)
    return handler.call(this, op, ctx)
  }

  /** Publishes a shallow patch of the snapshot. Values must be JSON (use
   *  null, not undefined, to clear). */
  protected publish(patch: Partial<S>): void {
    if (this.disposed) return
    const changed = Object.entries(patch).filter(([key, value]) => !Object.is(this.state[key], value))
    if (changed.length === 0) return
    const change = Object.fromEntries(changed) as JsonObject
    this.state = { ...this.state, ...change }
    this.rev++
    for (const subscriber of [...this.subscribers]) subscriber.change(this.rev, change)
  }

  /** Sends a chunk of the panel's byte stream to every subscriber. */
  protected emitBytes(chunk: Uint8Array): void {
    if (this.disposed) return
    for (const subscriber of [...this.subscribers]) subscriber.bytes(chunk)
  }

  /** Chunks a new subscriber gets right after the snapshot (a serialized
   *  screen, a Yjs state update). */
  protected initialBytes(): Uint8Array[] { return [] }

  /** Bytes a client wrote to the channel (keystrokes, Yjs updates). */
  input(_bytes: Uint8Array, _ctx: OpContext): void {}

  /** @internal The host attaches a channel subscriber. */
  attach(subscriber: SessionSubscriber): () => void {
    if (this.disposed) {
      subscriber.gone()
      return () => {}
    }
    subscriber.snapshot(this.rev, this.state)
    for (const chunk of this.initialBytes()) subscriber.bytes(chunk)
    this.subscribers.add(subscriber)
    return () => { this.subscribers.delete(subscriber) }
  }

  protected persisted<T extends Json>(): T | undefined {
    return this.kit.store.read() as T | undefined
  }

  protected persist(value: Json): void {
    if (!this.disposed) this.kit.store.write(value)
  }

  /** Runs a page operation on the panel's native surface through the driving
   *  client; `no-renderer` when none is connected. */
  protected withSurface<T = unknown>(op: string, args?: unknown, options?: SurfaceCallOptions): Promise<T> {
    if (this.disposed) return Promise.reject(new RpcError('gone', `panel ${this.panelId} is gone`))
    return this.kit.surface(op, args, options) as Promise<T>
  }

  /** @internal Only the host disposes: on removePanels, replacePanel or shutdown. */
  dispose(reason: DisposeReason): void {
    if (this.disposed) return
    this.disposed = true
    const subscribers = [...this.subscribers]
    this.subscribers.clear()
    for (const subscriber of subscribers) subscriber.gone()
    this.release(reason)
  }

  protected release(_reason: DisposeReason): void {}
}

/** A session class the registry holds. */
export type PanelSessionClass = new (kit: SessionKit, record: PanelRecord) => PanelSession<JsonObject, unknown>

/** The session of types with no state of their own (canvas, surface). */
export class StatelessSession extends PanelSession<JsonObject, never> {
  constructor(kit: SessionKit, record: PanelRecord) {
    super(kit, record, {})
  }
}
