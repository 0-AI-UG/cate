// Byte helpers shared by security, pairing and workspace data. Pure.

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

export { bytesToHex, hexToBytes }

// RFC 4648 alphabet, lowercase, no padding.
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

export function base32Encode(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

/** Decodes lowercase or uppercase base32 without padding. Throws on bad input. */
export function base32Decode(text: string): Uint8Array {
  const input = text.toLowerCase()
  const out = new Uint8Array(Math.floor((input.length * 5) / 8))
  let bits = 0
  let value = 0
  let index = 0
  for (const char of input) {
    const digit = BASE32.indexOf(char)
    if (digit < 0) throw new Error(`invalid base32 character '${char}'`)
    value = ((value << 5) | digit) & 0xffff
    bits += 5
    if (bits >= 8) {
      out[index++] = (value >>> (bits - 8)) & 0xff
      bits -= 8
    }
  }
  return out
}

/** Constant-time for equal lengths; different lengths are simply unequal. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export const utf8Encode = (text: string): Uint8Array => new TextEncoder().encode(text)
export const utf8Decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
