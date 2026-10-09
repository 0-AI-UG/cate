// defineCapability: a capability is declared once, with typed named
// parameters, and both sides are derived from the declaration. The daemon
// serves it generically (runtime/server) and clients get a typed proxy
// (client/proxy). `__types` is a phantom: it never exists at run time.

export interface MethodOptions {
  /** The call changes something: the client attaches an opId so a resend is
   *  applied once. */
  mutates?: boolean
  /** Default deadline for this method; 0 disables it. */
  timeoutMs?: number
  /** Callable across protocol majors (`runtime.update`, `runtime.info`), so an
   *  incompatible runtime can still be updated. The method's params and
   *  result must never change shape. */
  crossMajor?: boolean
}

export interface StreamDeclOptions {
  /** The stream carries binary chunks (flow controlled with `ack`). */
  bytes?: boolean
}

export interface MethodSpec<P = unknown, R = unknown> {
  readonly kind: 'method'
  readonly mutates: boolean
  readonly timeoutMs?: number
  readonly crossMajor: boolean
  readonly __types?: { params: P; result: R }
}

export interface StreamSpec<P = unknown, E = unknown, R = unknown> {
  readonly kind: 'stream'
  readonly bytes: boolean
  readonly __types?: { params: P; event: E; result: R }
}

/** Declares a method taking named params `P` and resolving to `R`. */
export function method<P = void, R = void>(opts: MethodOptions = {}): MethodSpec<P, R> {
  return {
    kind: 'method',
    mutates: opts.mutates === true,
    crossMajor: opts.crossMajor === true,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  }
}

/** Declares a stream taking named params `P`, emitting events `E` and ending with `R`. */
export function stream<P = void, E = never, R = void>(opts: StreamDeclOptions = {}): StreamSpec<P, E, R> {
  return { kind: 'stream', bytes: opts.bytes === true }
}

// `any` here lets any concrete spec satisfy the constraint; the concrete types
// are recovered with `infer` below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyMethodSpec = MethodSpec<any, any>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyStreamSpec = StreamSpec<any, any, any>

export type MethodSpecs = Record<string, AnyMethodSpec>
export type StreamSpecs = Record<string, AnyStreamSpec>

export interface Capability<
  N extends string = string,
  M extends MethodSpecs = MethodSpecs,
  S extends StreamSpecs = StreamSpecs,
> {
  readonly name: N
  readonly methods: M
  readonly streams: S
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCapability = Capability<string, any, any>

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9]*$/

export function defineCapability<
  N extends string,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  M extends MethodSpecs = {},
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  S extends StreamSpecs = {},
>(name: N, def: { methods?: M; streams?: S }): Capability<N, M, S> {
  if (!NAME_RE.test(name)) throw new Error(`Invalid capability name "${name}"`)
  const methods = (def.methods ?? {}) as M
  const streams = (def.streams ?? {}) as S
  for (const key of [...Object.keys(methods), ...Object.keys(streams)]) {
    if (!NAME_RE.test(key)) throw new Error(`Invalid name "${name}.${key}"`)
  }
  for (const key of Object.keys(streams)) {
    if (key in methods) throw new Error(`"${name}.${key}" is declared as both method and stream`)
  }
  return Object.freeze({ name, methods: Object.freeze(methods), streams: Object.freeze(streams) })
}

// ---- Derived types ----------------------------------------------------------

export type ParamsOf<Sp> = Sp extends { __types?: { params: infer P } } ? P : never
export type ResultOf<Sp> = Sp extends { __types?: { result: infer R } } ? R : never
export type EventOf<Sp> = Sp extends { __types?: { event: infer E } } ? E : never

export interface CallOptions {
  /** Overrides the declared or default deadline; 0 disables it. */
  timeoutMs?: number
  /** Aborting sends `cancel` and rejects the call. */
  signal?: AbortSignal
}

export interface SubscribeOptions {
  signal?: AbortSignal
  /** Acknowledge bytes yourself with `ack()` once they reached their
   *  destination, instead of right after the byte listeners return. */
  manualAck?: boolean
  /** Re-open the stream on reconnect instead of failing it. Right for streams
   *  that start with a snapshot. */
  resume?: boolean
}

/** A client-side handle on a running stream. */
export interface Subscription<E, R = unknown> extends AsyncIterable<E> {
  onEvent(listener: (event: E) => void): () => void
  onBytes(listener: (bytes: Uint8Array) => void): () => void
  /** Sends a binary chunk to the stream's handler on the runtime. */
  write(bytes: Uint8Array): void
  /** Only with `manualAck`. */
  ack(bytes: number): void
  /** Resolves with the stream's result when the runtime ends it. */
  readonly done: Promise<R>
  cancel(): void
}

type Call<P, R, O> = [P] extends [void]
  ? (params?: undefined, opts?: O) => R
  : (params: P, opts?: O) => R

export type MethodCall<Sp> = Call<ParamsOf<Sp>, Promise<ResultOf<Sp>>, CallOptions>
export type StreamCall<Sp> = Call<ParamsOf<Sp>, Subscription<EventOf<Sp>, ResultOf<Sp>>, SubscribeOptions>

export type CapabilityProxy<C extends AnyCapability> = {
  readonly [K in keyof C['methods']]: MethodCall<C['methods'][K]>
} & {
  readonly [K in keyof C['streams']]: StreamCall<C['streams'][K]>
}
