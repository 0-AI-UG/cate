// The Cate Connect wire protocol. Two endpoints on the service:
//
// `<url>/runtime`: a runtime keeps one connection here. It runs Noise as the
//   initiator with its static key (prologue `cate-connect/1`), then sends
//   `register` with its network id, which the key derives (`networkIdOf`).
//   The service refuses an id that is not its key's and keeps no bindings.
//   Signaling for incoming sessions arrives on the same connection.
// `<url>/client`: a client looks a runtime up and opens a session, then
//   relays the WebRTC offer, answer and ICE candidates through it. Once the
//   data channel is open the client hangs up; the service never carries
//   workspace traffic.
//
// ICE servers come with `opened` (client) and `incoming` (runtime), fresh for
// each session: STUN, and a TURN relay with short-lived credentials when the
// service has one. ICE prefers a direct path and falls back to the relay; the
// relay only ever carries the Noise-encrypted data channel. `registered` and
// `lookup` carry them too.
//
// A registered runtime may also ask the service to deliver a push to a
// paired device (`push`), when `registered` said the service sends pushes.
// The payload is sealed for the device; the service only delivers it.
//
// Every message is one binary WebSocket message holding UTF-8 JSON (inside
// Noise on the runtime endpoint).

import { utf8Decode, utf8Encode } from '../../security/contract'
import type { IceServer, SignalMessage } from '../../transports/contract'

export const CONNECT_PROTOCOL = 2
export const CONNECT_PROLOGUE = utf8Encode('cate-connect/1')
/** Override with `CATE_CONNECT_URL`. */
export const DEFAULT_CATE_CONNECT_URL = 'wss://connect.cate.cero-ai.com'

export type ConnectRole = 'runtime' | 'client'

export function connectEndpoint(url: string, role: ConnectRole): string {
  return `${url.replace(/\/+$/, '')}/${role}`
}

export type RegisterRefusal = 'key-mismatch' | 'malformed' | 'protocol'

/** A push for the service to deliver. */
export interface ConnectPush {
  /** Where the device's push service delivers, as the device registered it:
   *  `apns:<sandbox|production>:<hex token>`. Only the service reads it. */
  target: string
  /** The notification sealed for the device (base64); opaque to the service. */
  sealed: string
  /** A newer push with the same id replaces the older on the device. */
  collapseId: string
}

/** `bad-target`: the target is unknown or gone; stop sending to it. */
export type ConnectPushResult = 'sent' | 'unavailable' | 'bad-target' | 'rate-limited' | 'failed'

/** Runtime to service. */
export type RuntimeMessage =
  | { t: 'register'; runtimeId: string; protocol: number }
  | { t: 'signal'; session: string; signal: SignalMessage }
  | { t: 'push'; id: string; push: ConnectPush }

/** Service to runtime. `push` on `registered`: the service forwards pushes. */
export type ServiceRuntimeMessage =
  | { t: 'registered'; iceServers: IceServer[]; push?: boolean }
  | { t: 'pushed'; id: string; result: ConnectPushResult }
  | { t: 'refused'; reason: RegisterRefusal }
  | { t: 'incoming'; session: string; iceServers: IceServer[] }
  | { t: 'signal'; session: string; signal: SignalMessage }
  | { t: 'ended'; session: string }

/** Client to service. */
export type ClientMessage =
  | { t: 'lookup'; runtimeId: string }
  | { t: 'open'; runtimeId: string }
  | { t: 'signal'; session: string; signal: SignalMessage }

export type ServiceErrorCode = 'offline' | 'malformed' | 'unknown-session'

/** Service to client. */
export type ServiceClientMessage =
  | { t: 'lookup'; runtimeId: string; online: boolean; iceServers: IceServer[] }
  | { t: 'opened'; session: string; iceServers: IceServer[] }
  | { t: 'error'; code: ServiceErrorCode; message?: string }
  | { t: 'signal'; session: string; signal: SignalMessage }
  | { t: 'ended'; session: string }

export type ConnectMessage = RuntimeMessage | ServiceRuntimeMessage | ClientMessage | ServiceClientMessage

export function encodeConnectMessage(message: ConnectMessage): Uint8Array {
  return utf8Encode(JSON.stringify(message))
}

function parse(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(utf8Decode(bytes))
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
const isRuntimeId = (value: unknown): value is string => typeof value === 'string' && /^[a-z2-7]{16}$/.test(value)
const PUSH_RESULTS: readonly ConnectPushResult[] = ['sent', 'unavailable', 'bad-target', 'rate-limited', 'failed']

export function isConnectPush(value: unknown): value is ConnectPush {
  if (!value || typeof value !== 'object') return false
  const p = value as Record<string, unknown>
  return typeof p.target === 'string' && p.target.length <= 256 && /^[a-z0-9]+:[A-Za-z0-9:._-]+$/.test(p.target)
    && typeof p.sealed === 'string' && p.sealed.length <= 3_000 && /^[A-Za-z0-9+/]+=*$/.test(p.sealed)
    && typeof p.collapseId === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(p.collapseId)
}

export function isSignal(value: unknown): value is SignalMessage {
  if (!value || typeof value !== 'object') return false
  const signal = value as Record<string, unknown>
  if (signal.kind === 'description') {
    const d = signal.description as Record<string, unknown> | undefined
    return !!d && (d.type === 'offer' || d.type === 'answer') && typeof d.sdp === 'string' && d.sdp.length < 64 * 1024
  }
  if (signal.kind === 'candidate') {
    const c = signal.candidate as Record<string, unknown> | undefined
    return !!c && typeof c.candidate === 'string' && c.candidate.length < 4096
      && (c.sdpMid === null || typeof c.sdpMid === 'string')
  }
  return false
}

function isIceServers(value: unknown): value is IceServer[] {
  return Array.isArray(value) && value.every((server) => {
    if (!server || typeof server !== 'object') return false
    const urls = (server as IceServer).urls
    return typeof urls === 'string' || (Array.isArray(urls) && urls.every((url) => typeof url === 'string'))
  })
}

export function decodeRuntimeMessage(bytes: Uint8Array): RuntimeMessage | null {
  const m = parse(bytes)
  if (!m) return null
  if (m.t === 'register' && isRuntimeId(m.runtimeId) && typeof m.protocol === 'number') {
    return { t: 'register', runtimeId: m.runtimeId, protocol: m.protocol }
  }
  if (m.t === 'signal' && isString(m.session) && isSignal(m.signal)) return { t: 'signal', session: m.session, signal: m.signal }
  if (m.t === 'push' && isString(m.id) && m.id.length <= 64 && isConnectPush(m.push)) {
    const { target, sealed, collapseId } = m.push
    return { t: 'push', id: m.id, push: { target, sealed, collapseId } }
  }
  return null
}

export function decodeServiceRuntimeMessage(bytes: Uint8Array): ServiceRuntimeMessage | null {
  const m = parse(bytes)
  if (!m) return null
  switch (m.t) {
    case 'registered':
      return isIceServers(m.iceServers) ? { t: 'registered', iceServers: m.iceServers, ...(m.push === true ? { push: true } : {}) } : null
    case 'pushed':
      return isString(m.id) && PUSH_RESULTS.includes(m.result as ConnectPushResult) ? { t: 'pushed', id: m.id, result: m.result as ConnectPushResult } : null
    case 'refused':
      return m.reason === 'key-mismatch' || m.reason === 'malformed' || m.reason === 'protocol' ? { t: 'refused', reason: m.reason } : null
    case 'incoming':
      return isString(m.session) && isIceServers(m.iceServers) ? { t: 'incoming', session: m.session, iceServers: m.iceServers } : null
    case 'ended': return isString(m.session) ? { t: 'ended', session: m.session } : null
    case 'signal': return isString(m.session) && isSignal(m.signal) ? { t: 'signal', session: m.session, signal: m.signal } : null
    default: return null
  }
}

export function decodeClientMessage(bytes: Uint8Array): ClientMessage | null {
  const m = parse(bytes)
  if (!m) return null
  if ((m.t === 'lookup' || m.t === 'open') && isRuntimeId(m.runtimeId)) return { t: m.t, runtimeId: m.runtimeId }
  if (m.t === 'signal' && isString(m.session) && isSignal(m.signal)) return { t: 'signal', session: m.session, signal: m.signal }
  return null
}

export function decodeServiceClientMessage(bytes: Uint8Array): ServiceClientMessage | null {
  const m = parse(bytes)
  if (!m) return null
  switch (m.t) {
    case 'lookup':
      return isRuntimeId(m.runtimeId) && typeof m.online === 'boolean' && isIceServers(m.iceServers)
        ? { t: 'lookup', runtimeId: m.runtimeId, online: m.online, iceServers: m.iceServers }
        : null
    case 'opened': return isString(m.session) && isIceServers(m.iceServers) ? { t: 'opened', session: m.session, iceServers: m.iceServers } : null
    case 'error':
      return m.code === 'offline' || m.code === 'malformed' || m.code === 'unknown-session'
        ? { t: 'error', code: m.code, ...(typeof m.message === 'string' ? { message: m.message } : {}) }
        : null
    case 'ended': return isString(m.session) ? { t: 'ended', session: m.session } : null
    case 'signal': return isString(m.session) && isSignal(m.signal) ? { t: 'signal', session: m.session, signal: m.signal } : null
    default: return null
  }
}
