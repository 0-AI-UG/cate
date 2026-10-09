// Error codes of the runtime protocol (architecture 7.8).

export const RPC_ERROR_CODES = [
  'gone',        // the panel or thing no longer exists
  'conflict',    // the write's base is stale
  'dirty',       // unsaved work; retry with an explicit choice
  'rejected',    // invalid op
  'untrusted',   // workspace not trusted (9.2)
  'unsupported', // the other side has no such capability, method or stream
  'no-renderer', // no client can run the page operation (10.2)
  'timeout',
  'duplicate',   // an op already handled whose outcome is no longer kept
] as const

export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number]

const CODE_SET: ReadonlySet<string> = new Set(RPC_ERROR_CODES)

export function isRpcErrorCode(value: unknown): value is RpcErrorCode {
  return typeof value === 'string' && CODE_SET.has(value)
}

/** An error as it travels in `res`. Handlers that throw a plain Error send no code. */
export interface WireError {
  message: string
  code?: RpcErrorCode
  data?: unknown
}

export class RpcError extends Error {
  readonly code: RpcErrorCode
  readonly data?: unknown

  constructor(code: RpcErrorCode, message?: string, data?: unknown) {
    super(message ?? code)
    this.name = 'RpcError'
    this.code = code
    if (data !== undefined) this.data = data
  }
}

export function isRpcError(err: unknown, code?: RpcErrorCode): err is RpcError {
  return err instanceof RpcError && (code === undefined || err.code === code)
}

/** The peer speaks a different protocol major (7.10). Not a wire code: it is
 *  decided locally from the peer's `hello`. */
export class IncompatibleProtocolError extends Error {
  constructor(
    readonly local: readonly [number, number],
    readonly remote: readonly [number, number],
    readonly remoteVersion: string,
  ) {
    super(`Incompatible runtime protocol ${remote.join('.')} (this side speaks ${local.join('.')})`)
    this.name = 'IncompatibleProtocolError'
  }
}

/** The runtime runs another build than this client (a stale daemon). */
export class IncompatibleBuildError extends Error {
  constructor(readonly local: string, readonly remote: string | undefined) {
    super(`The runtime runs build ${remote ?? 'unknown'}, this app is build ${local}`)
    this.name = 'IncompatibleBuildError'
  }
}

/** The connection closed or the client was closed while the call was in flight. */
export class ConnectionClosedError extends Error {
  constructor(message = 'Runtime connection closed') {
    super(message)
    this.name = 'ConnectionClosedError'
  }
}

/** The call or stream was cancelled on this side. */
export class CancelledError extends Error {
  constructor(message = 'Cancelled') {
    super(message)
    this.name = 'CancelledError'
  }
}

export function toWireError(err: unknown): WireError {
  if (err instanceof RpcError) {
    return err.data === undefined
      ? { code: err.code, message: err.message }
      : { code: err.code, message: err.message, data: err.data }
  }
  return { message: err instanceof Error ? err.message : String(err) }
}

export function fromWireError(wire: WireError): Error {
  if (isRpcErrorCode(wire.code)) return new RpcError(wire.code, wire.message, wire.data)
  return new Error(wire.message)
}
