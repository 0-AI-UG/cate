// What a push carries, sealed for one device: ChaCha20-Poly1305 under the
// device's own key, as base64 of nonce (12) || ciphertext || tag (16), the
// layout CryptoKit's `ChaChaPoly.SealedBox(combined:)` opens.

import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { randomBytes } from '@noble/hashes/utils.js'
import { utf8Encode } from '@runtime/security/contract'

export const PUSH_KEY_BYTES = 32
const NONCE_BYTES = 12

/** One notification event (architecture 10.5), sealed: the device decides
 *  how to show it. */
export interface PushMessage {
  runtimeId: string
  /** The workspace folder's name. */
  workspace: string
  /** The event's kind (`agent.needsInput`, `cate.ui.notify`, ...). */
  kind: string
  panelId: string | null
  title: string
  body: string
}

/** The id a device files the notification under: a newer one about the same
 *  panel replaces the older. Clients file their own banners under it too. */
export function pushCollapseId(runtimeId: string, panelId: string | undefined, now: number): string {
  return panelId ? `${runtimeId}.${panelId}`.slice(0, 64) : `${runtimeId}.notice.${now}`
}

export function sealPushMessage(key: Uint8Array, message: PushMessage, nonce: Uint8Array = randomBytes(NONCE_BYTES)): string {
  const sealed = chacha20poly1305(key, nonce).encrypt(utf8Encode(JSON.stringify(message)))
  const combined = new Uint8Array(NONCE_BYTES + sealed.length)
  combined.set(nonce)
  combined.set(sealed, NONCE_BYTES)
  return encodeBase64(combined)
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Throws on text that is not base64. */
export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
