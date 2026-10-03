import { x25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { base32Encode, bytesToHex, hexToBytes } from './encoding'

/** A long-lived X25519 static key pair (runtime or device). */
export interface KeyPair {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

/** The JSON form stored in `secrets.json` and `device-key.json`. */
export interface StoredKeyPair {
  publicKey: string
  secretKey: string
}

export const KEY_LENGTH = 32
export const FINGERPRINT_LENGTH = 20

export function generateKeyPair(): KeyPair {
  return keyPairFromSecret(x25519.utils.randomSecretKey())
}

export function keyPairFromSecret(secretKey: Uint8Array): KeyPair {
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) }
}

/** First 20 characters of the lowercase unpadded base32 SHA-256 of the key. */
export function fingerprint(publicKey: Uint8Array): string {
  return base32Encode(sha256(publicKey)).slice(0, FINGERPRINT_LENGTH)
}

export function encodeKeyPair(pair: KeyPair): StoredKeyPair {
  return { publicKey: bytesToHex(pair.publicKey), secretKey: bytesToHex(pair.secretKey) }
}

/** Returns null when the stored value is not a valid key pair. */
export function decodeKeyPair(value: unknown): KeyPair | null {
  if (!value || typeof value !== 'object') return null
  const { secretKey, publicKey } = value as Partial<StoredKeyPair>
  if (typeof secretKey !== 'string' || typeof publicKey !== 'string') return null
  try {
    const pair = keyPairFromSecret(hexToBytes(secretKey))
    return bytesToHex(pair.publicKey) === publicKey.toLowerCase() ? pair : null
  } catch {
    return null
  }
}

export const encodePublicKey = (key: Uint8Array): string => bytesToHex(key)

export function decodePublicKey(text: string): Uint8Array {
  const key = hexToBytes(text)
  if (key.length !== KEY_LENGTH) throw new Error('invalid public key length')
  return key
}
