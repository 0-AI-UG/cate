// Opening a sealed push as the device does (the iOS notification service
// extension uses CryptoKit), for tests of what the runtime seals.

import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { decodeBase64, type PushMessage } from '@runtime/push/contract'
import { utf8Decode } from '@runtime/security/contract'

const NONCE_BYTES = 12

/** The message, or null when `sealed` is not one sealed under `key`. */
export function openPushMessage(key: Uint8Array, sealed: string): PushMessage | null {
  try {
    const combined = decodeBase64(sealed)
    const plain = chacha20poly1305(key, combined.subarray(0, NONCE_BYTES)).decrypt(combined.subarray(NONCE_BYTES))
    return JSON.parse(utf8Decode(plain)) as PushMessage
  } catch {
    return null
  }
}
