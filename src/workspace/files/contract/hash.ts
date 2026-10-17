import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

const encoder = new TextEncoder()

/** Hex SHA-256 of a file's bytes (text is hashed as UTF-8). A write names the
 *  hash it is based on; the runtime compares it with the bytes on disk. */
export function contentHash(content: string | Uint8Array): string {
  return bytesToHex(sha256(typeof content === 'string' ? encoder.encode(content) : content))
}

// Base64 for the few binary values that travel in JSON params (Yjs state
// vectors). Bulk bytes go as stream chunks instead.
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
