// The pairing payload (QR code) and the typed pairing code. Pure.

import { base32Decode, base32Encode } from '../../security/contract'

export type PairingMode = 'sameNetwork' | 'cateConnect'

export const PAIRING_SECRET_BYTES = 10
export const PAIRING_SECRET_TTL_MS = 10 * 60_000
const RUNTIME_ID_CHARS = 16
const SECRET_CHARS = 16
const FINGERPRINT_CHARS = 20

export interface PairingPayload {
  runtimeId: string
  /** Fingerprint of the runtime's static key. */
  fingerprint: string
  secret: Uint8Array
  mode: PairingMode
  /** LAN addresses (`host:port`) for clients that cannot use mDNS. */
  addresses: string[]
}

/** What a typed pairing code carries: no key fingerprint, no addresses. */
export interface PairingCode {
  runtimeId: string
  secret: Uint8Array
}

export class PairingFormatError extends Error {}

const BASE32_RE = /^[a-z2-7]+$/

function checkBase32(value: string | undefined, length: number, what: string): string {
  if (!value || value.length !== length || !BASE32_RE.test(value)) throw new PairingFormatError(`invalid ${what}`)
  return value
}

function checkSecret(secret: Uint8Array): void {
  if (secret.length !== PAIRING_SECRET_BYTES) throw new PairingFormatError('invalid secret')
}

export function encodePairingUri(payload: PairingPayload): string {
  checkSecret(payload.secret)
  const params: Array<[string, string]> = [
    ['r', payload.runtimeId],
    ['k', payload.fingerprint],
    ['s', base32Encode(payload.secret)],
    ['m', payload.mode],
    ['a', payload.addresses.join(',')],
  ]
  return `cate://pair?${params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`
}

// Parsed by hand: URL and URLSearchParams are not reliable on every mobile JS engine.
export function decodePairingUri(uri: string): PairingPayload {
  const prefix = 'cate://pair?'
  if (!uri.startsWith(prefix)) throw new PairingFormatError('not a cate pairing link')
  const params = new Map<string, string>()
  for (const part of uri.slice(prefix.length).split('&')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    try {
      params.set(part.slice(0, eq), decodeURIComponent(part.slice(eq + 1)))
    } catch {
      throw new PairingFormatError('invalid escape in pairing link')
    }
  }
  const mode = params.get('m')
  if (mode !== 'sameNetwork' && mode !== 'cateConnect') throw new PairingFormatError('invalid mode')
  const secret = base32Decode(checkBase32(params.get('s'), SECRET_CHARS, 'secret'))
  return {
    runtimeId: checkBase32(params.get('r'), RUNTIME_ID_CHARS, 'runtime id'),
    fingerprint: checkBase32(params.get('k'), FINGERPRINT_CHARS, 'key fingerprint'),
    secret,
    mode,
    addresses: (params.get('a') ?? '').split(',').filter((address) => address.length > 0),
  }
}

/** 32 base32 characters (runtimeId, then the secret) in dash-separated groups of four. */
export function formatPairingCode(code: PairingCode): string {
  checkSecret(code.secret)
  checkBase32(code.runtimeId, RUNTIME_ID_CHARS, 'runtime id')
  const chars = code.runtimeId + base32Encode(code.secret)
  return chars.match(/.{4}/g)!.join('-')
}

/** Accepts any case and spacing; 0, 1 and 8 are read as o, l and b. */
export function parsePairingCode(text: string): PairingCode {
  const chars = text
    .toLowerCase()
    .replace(/[\s-]/g, '')
    .replace(/0/g, 'o')
    .replace(/1/g, 'l')
    .replace(/8/g, 'b')
  checkBase32(chars, RUNTIME_ID_CHARS + SECRET_CHARS, 'pairing code')
  return {
    runtimeId: chars.slice(0, RUNTIME_ID_CHARS),
    secret: base32Decode(chars.slice(RUNTIME_ID_CHARS)),
  }
}
