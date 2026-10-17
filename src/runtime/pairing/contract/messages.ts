// The pairing exchange. It runs on the secure channel right after the
// handshake, before the protocol `hello`, and is the only thing a runtime
// accepts from an unknown key. Pure.

import { bytesToHex, hexToBytes, utf8Decode, utf8Encode } from '../../security/contract'
import { SECRET_ID_CHARS } from './payload'

export const DEVICE_NAME_MAX = 64

export interface PairRequest {
  type: 'pair'
  deviceName: string
  /** Which live secret the proof is for (sent in clear; it is no secret). */
  secretId: string
  /** hex clientProof */
  proof: string
}

export type PairRejectReason = 'invalid-proof' | 'no-secret' | 'malformed'

export type PairAnswer =
  | { type: 'paired'; /** hex runtimeProof */ proof: string }
  | { type: 'pair-rejected'; reason: PairRejectReason }

export type PairMessage = PairRequest | PairAnswer

export function encodePairMessage(message: PairMessage): Uint8Array {
  return utf8Encode(JSON.stringify(message))
}

/** Returns null for anything that is not a well-formed pairing message. */
export function decodePairMessage(bytes: Uint8Array): PairMessage | null {
  let value: unknown
  try {
    value = JSON.parse(utf8Decode(bytes))
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const message = value as Record<string, unknown>
  switch (message.type) {
    case 'pair':
      return typeof message.deviceName === 'string' && isSecretId(message.secretId) && isProof(message.proof)
        ? { type: 'pair', deviceName: message.deviceName, secretId: message.secretId, proof: message.proof }
        : null
    case 'paired':
      return isProof(message.proof) ? { type: 'paired', proof: message.proof } : null
    case 'pair-rejected':
      return message.reason === 'invalid-proof' || message.reason === 'no-secret' || message.reason === 'malformed'
        ? { type: 'pair-rejected', reason: message.reason }
        : null
    default:
      return null
  }
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
