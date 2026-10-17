// Proofs bind the one-time secret to one Noise session (its handshake hash),
// so neither side can be impersonated by a party in the middle. Pure.

import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesEqual, concatBytes, utf8Encode } from '../../security/contract'

const CLIENT_LABEL = utf8Encode('cate-pair-client')
const RUNTIME_LABEL = utf8Encode('cate-pair-runtime')

/** HMAC-SHA256(secret, "cate-pair-client" || handshakeHash) */
export function clientProof(secret: Uint8Array, handshakeHash: Uint8Array): Uint8Array {
  return hmac(sha256, secret, concatBytes(CLIENT_LABEL, handshakeHash))
}

/** HMAC-SHA256(secret, "cate-pair-runtime" || handshakeHash) */
export function runtimeProof(secret: Uint8Array, handshakeHash: Uint8Array): Uint8Array {
  return hmac(sha256, secret, concatBytes(RUNTIME_LABEL, handshakeHash))
}

export function verifyClientProof(secret: Uint8Array, handshakeHash: Uint8Array, proof: Uint8Array): boolean {
  return bytesEqual(clientProof(secret, handshakeHash), proof)
}

export function verifyRuntimeProof(secret: Uint8Array, handshakeHash: Uint8Array, proof: Uint8Array): boolean {
  return bytesEqual(runtimeProof(secret, handshakeHash), proof)
}
