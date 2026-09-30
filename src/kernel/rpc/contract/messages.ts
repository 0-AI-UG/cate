// Messages of the runtime protocol (architecture 7.8). Parameters are named
// objects, never positional arrays. A stream is a `req` whose method names a
// declared stream: its events arrive as `evt` (and binary chunks) keyed by the
// request id, and its `res` ends it.

import type { WireError } from './errors'

/** Same major is compatible; minors only add optional things. */
export const PROTOCOL = [1, 0] as const satisfies readonly [number, number]

export type ProtocolVersion = readonly [major: number, minor: number]

export interface DeviceInfo {
  name: string
  /** Checked against the handshake on network transports. */
  keyFingerprint: string
}

/** Hello payload of a client (desktop app, phone). Fixed for the connection. */
export interface ClientHello {
  clientId: string
  device: DeviceInfo
  /** Unknown entries are ignored by the receiver. */
  features: string[]
}

/** Hello payload of a caller (the CLI, a T3 harness). */
export interface CallerHello {
  token: string
}

export interface HelloMessage {
  t: 'hello'
  protocol: ProtocolVersion
  /** App or daemon release version. */
  version: string
  client?: ClientHello
  caller?: CallerHello
  /** Runtime only: the connection was refused (bad token, device mismatch). */
  error?: WireError
}

export interface ReqMessage {
  t: 'req'
  id: number
  cap: string
  method: string
  params?: unknown
  /** `clientId:counter`, on calls that change something. */
  opId?: string
}

export type ResMessage =
  | { t: 'res'; id: number; result?: unknown }
  | { t: 'res'; id: number; error: WireError }

export interface EvtMessage {
  t: 'evt'
  stream: number
  data: unknown
}

export interface CancelMessage {
  t: 'cancel'
  id: number
}

/** Flow control: the receiver of a byte stream delivered `bytes` more bytes. */
export interface AckMessage {
  t: 'ack'
  stream: number
  bytes: number
}

export type Message = HelloMessage | ReqMessage | ResMessage | EvtMessage | CancelMessage | AckMessage

/** What every transport carries: a JSON message or a binary chunk of a stream. */
export type Frame =
  | { kind: 'msg'; msg: Message }
  | { kind: 'bytes'; streamId: number; bytes: Uint8Array }

export function isCompatible(a: ProtocolVersion, b: ProtocolVersion): boolean {
  return a[0] === b[0]
}

const MESSAGE_TYPES: ReadonlySet<string> = new Set(['hello', 'req', 'res', 'evt', 'cancel', 'ack'])

export function isMessage(value: unknown): value is Message {
  return typeof value === 'object' && value !== null && MESSAGE_TYPES.has((value as { t?: unknown }).t as string)
}
