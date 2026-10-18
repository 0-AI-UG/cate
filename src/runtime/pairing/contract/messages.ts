// What opens every network connection, right after the handshake: the
// device says what it wants (`pair` with a code, or `connect` by key), and the
// runtime acts on that and on whether it knows the key (architecture 7.6).
// A `pair` is answered and ends the connection; a `connect` is followed by the
// protocol's frames. Pure.

import { bytesToHex, hexToBytes, utf8Decode, utf8Encode } from '../../security/contract'
import { SECRET_ID_CHARS } from './payload'

export const DEVICE_NAME_MAX = 64

/** How long a connection has to send its opening after the handshake. */
export const OPENING_TIMEOUT_MS = 10_000

export interface PairRequest {
  type: 'pair'
  deviceName: string
  /** Which live secret the proof is for (sent in clear; it is no secret). */
  secretId: string
  /** hex clientProof */
  proof: string
}

/** A paired device reconnecting by key; no answer, the protocol follows. */
export interface ConnectRequest {
  type: 'connect'
}

export type Opening = PairRequest | ConnectRequest

export type PairRejectReason = 'invalid-proof' | 'no-secret'

export type PairAnswer =
  | { type: 'paired'; /** hex runtimeProof */ proof: string }
  | { type: 'pair-rejected'; reason: PairRejectReason }

/** What the runtime made of a connection's opening. */
export type Admission =
  /** A paired device: the protocol follows. */
  | { kind: 'connect' }
  /** `connect` from a key that is not (or no longer) paired: refused. */
  | { kind: 'unpaired' }
  /** Paired now (again, for a known key); answered, the connection ends. */
  | { kind: 'paired'; deviceName: string }
  /** A `pair` the runtime said no to; answered, the connection ends. */
  | { kind: 'pair-rejected'; reason: PairRejectReason }
  /** Nothing, or nothing it understands, in time. */
  | { kind: 'no-opening' }

export const encodeOpening = (opening: Opening): Uint8Array => encodeJson(opening)
export const encodePairAnswer = (answer: PairAnswer): Uint8Array => encodeJson(answer)

/** Returns null for anything that is not a well-formed opening. */
export function decodeOpening(bytes: Uint8Array): Opening | null {
  const message = decodeJson(bytes)
  switch (message?.type) {
    case 'connect':
      return { type: 'connect' }
    case 'pair':
      return typeof message.deviceName === 'string' && isSecretId(message.secretId) && isProof(message.proof)
        ? { type: 'pair', deviceName: message.deviceName, secretId: message.secretId, proof: message.proof }
        : null
    default:
      return null
  }
}

/** Returns null for anything that is not a well-formed answer. */
export function decodePairAnswer(bytes: Uint8Array): PairAnswer | null {
  const message = decodeJson(bytes)
  switch (message?.type) {
    case 'paired':
      return isProof(message.proof) ? { type: 'paired', proof: message.proof } : null
    case 'pair-rejected':
      return message.reason === 'invalid-proof' || message.reason === 'no-secret'
        ? { type: 'pair-rejected', reason: message.reason }
        : null
    default:
      return null
  }
}

const encodeJson = (value: unknown): Uint8Array => utf8Encode(JSON.stringify(value))

function decodeJson(bytes: Uint8Array): Record<string, unknown> | null {
  let value: unknown
  try {
    value = JSON.parse(utf8Decode(bytes))
  } catch {
    return null
  }
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

const isSecretId = (value: unknown): value is string =>
  typeof value === 'string' && value.length === SECRET_ID_CHARS && /^[a-z2-7]+$/.test(value)
const isProof = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

export const proofToWire = (proof: Uint8Array): string => bytesToHex(proof)
export const proofFromWire = (proof: string): Uint8Array => hexToBytes(proof)

/** Trimmed, control characters removed, bounded length; never empty. */
export function cleanDeviceName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, DEVICE_NAME_MAX)
  return cleaned || 'Unnamed device'
}
