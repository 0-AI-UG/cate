// Noise_XX_25519_ChaChaPoly_BLAKE2b, following the Noise spec revision 34
// (CipherState, SymmetricState, HandshakeState). Pure JS so the mobile client
// runs the same code. Rekey and PSK modifiers are not implemented.

import { x25519 } from '@noble/curves/ed25519.js'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { blake2b } from '@noble/hashes/blake2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { concatBytes, utf8Encode } from './encoding'
import { generateKeyPair, type KeyPair } from './keys'

export const NOISE_PROTOCOL_NAME = 'Noise_XX_25519_ChaChaPoly_BLAKE2b'
export const NOISE_MAX_MESSAGE = 65535
export const DHLEN = 32
export const HASHLEN = 64
const TAGLEN = 16
const EMPTY = new Uint8Array(0)

export class NoiseError extends Error {}

const hash = (data: Uint8Array): Uint8Array => blake2b(data)

function hkdf(chainingKey: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  const temp = hmac(blake2b, chainingKey, ikm)
  const out1 = hmac(blake2b, temp, Uint8Array.of(1))
  const out2 = hmac(blake2b, temp, concatBytes(out1, Uint8Array.of(2)))
  return [out1, out2]
}

function dh(keyPair: KeyPair, publicKey: Uint8Array): Uint8Array {
  try {
    return x25519.getSharedSecret(keyPair.secretKey, publicKey)
  } catch {
    throw new NoiseError('invalid DH public key')
  }
}

// ChaChaPoly nonce: 32 bits of zeros, then the 64-bit counter little-endian.
function nonceBytes(n: number): Uint8Array {
  const out = new Uint8Array(12)
  const view = new DataView(out.buffer)
  view.setUint32(4, n >>> 0, true)
  view.setUint32(8, Math.floor(n / 0x100000000), true)
  return out
}

export class CipherState {
  private key: Uint8Array | null = null
  private nonce = 0

  initializeKey(key: Uint8Array | null): void {
    this.key = key
    this.nonce = 0
  }

  hasKey(): boolean {
    return this.key !== null
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.key) return plaintext
    return chacha20poly1305(this.key, nonceBytes(this.nextNonce()), ad).encrypt(plaintext)
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.key) return ciphertext
    // The nonce advances only on success, as the spec requires.
    if (this.nonce >= Number.MAX_SAFE_INTEGER) throw new NoiseError('nonce exhausted')
    let plaintext: Uint8Array
    try {
      plaintext = chacha20poly1305(this.key, nonceBytes(this.nonce), ad).decrypt(ciphertext)
    } catch {
      throw new NoiseError('decryption failed')
    }
    this.nonce++
    return plaintext
  }

  private nextNonce(): number {
    // 2^64-1 is reserved; a JS number caps us far below it anyway.
    if (this.nonce >= Number.MAX_SAFE_INTEGER) throw new NoiseError('nonce exhausted')
    return this.nonce++
  }
}

export class SymmetricState {
  readonly cipher = new CipherState()
  private chainingKey: Uint8Array
  private h: Uint8Array

  constructor(protocolName: string) {
    const name = utf8Encode(protocolName)
    if (name.length <= HASHLEN) {
      this.h = new Uint8Array(HASHLEN)
      this.h.set(name)
    } else {
      this.h = hash(name)
    }
    this.chainingKey = this.h
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, tempK] = hkdf(this.chainingKey, ikm)
    this.chainingKey = ck
    this.cipher.initializeKey(tempK.slice(0, 32))
  }

  mixHash(data: Uint8Array): void {
    this.h = hash(concatBytes(this.h, data))
  }

  handshakeHash(): Uint8Array {
    return this.h
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encryptWithAd(this.h, plaintext)
    this.mixHash(ciphertext)
    return ciphertext
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decryptWithAd(this.h, ciphertext)
    this.mixHash(ciphertext)
    return plaintext
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf(this.chainingKey, EMPTY)
    const c1 = new CipherState()
    const c2 = new CipherState()
    c1.initializeKey(k1.slice(0, 32))
    c2.initializeKey(k2.slice(0, 32))
    return [c1, c2]
  }
}

type Token = 'e' | 's' | 'ee' | 'es' | 'se'

// XX:
//   -> e
//   <- e, ee, s, es
//   -> s, se
const XX: Token[][] = [['e'], ['e', 'ee', 's', 'es'], ['s', 'se']]

export interface HandshakeOptions {
  initiator: boolean
  staticKeys: KeyPair
  prologue?: Uint8Array
  /** Fixed ephemeral key, for test vectors only. */
  ephemeral?: KeyPair
}

export interface HandshakeResult {
  /** Cipher for frames this side sends. */
  send: CipherState
  /** Cipher for frames this side receives. */
  receive: CipherState
  remoteStatic: Uint8Array
  handshakeHash: Uint8Array
}

export class HandshakeState {
  private readonly symmetric = new SymmetricState(NOISE_PROTOCOL_NAME)
  private readonly initiator: boolean
  private readonly s: KeyPair
  private e: KeyPair | null = null
  private rs: Uint8Array | null = null
  private re: Uint8Array | null = null
  private readonly presetEphemeral: KeyPair | undefined
  private step = 0

  constructor(options: HandshakeOptions) {
    this.initiator = options.initiator
    this.s = options.staticKeys
    this.presetEphemeral = options.ephemeral
    this.symmetric.mixHash(options.prologue ?? EMPTY)
  }

  /** True when this side writes the next handshake message. */
  isMyTurn(): boolean {
    return !this.isComplete() && (this.step % 2 === 0) === this.initiator
  }

  isComplete(): boolean {
    return this.step >= XX.length
  }

  writeMessage(payload: Uint8Array = EMPTY): Uint8Array {
    if (!this.isMyTurn()) throw new NoiseError('not our turn to write')
    const parts: Uint8Array[] = []
    for (const token of XX[this.step]) {
      switch (token) {
        case 'e':
          this.e = this.presetEphemeral ?? generateKeyPair()
          parts.push(this.e.publicKey)
          this.symmetric.mixHash(this.e.publicKey)
          break
        case 's':
          parts.push(this.symmetric.encryptAndHash(this.s.publicKey))
          break
        default:
          this.mixToken(token)
      }
    }
    parts.push(this.symmetric.encryptAndHash(payload))
    this.step++
    const message = concatBytes(...parts)
    if (message.length > NOISE_MAX_MESSAGE) throw new NoiseError('handshake message too large')
    return message
  }

  readMessage(message: Uint8Array): Uint8Array {
    if (this.isComplete() || this.isMyTurn()) throw new NoiseError('not our turn to read')
    if (message.length > NOISE_MAX_MESSAGE) throw new NoiseError('handshake message too large')
    let offset = 0
    const take = (length: number): Uint8Array => {
      if (offset + length > message.length) throw new NoiseError('handshake message too short')
      const out = message.subarray(offset, offset + length)
      offset += length
      return out
    }
    for (const token of XX[this.step]) {
      switch (token) {
        case 'e':
          this.re = take(DHLEN).slice()
          this.symmetric.mixHash(this.re)
          break
        case 's': {
          const length = this.symmetric.cipher.hasKey() ? DHLEN + TAGLEN : DHLEN
          this.rs = this.symmetric.decryptAndHash(take(length))
          break
        }
        default:
          this.mixToken(token)
      }
    }
    const payload = this.symmetric.decryptAndHash(message.subarray(offset))
    this.step++
    return payload
  }

  /** Call once the handshake is complete. */
  finish(): HandshakeResult {
    if (!this.isComplete() || !this.rs) throw new NoiseError('handshake not complete')
    const [c1, c2] = this.symmetric.split()
    return {
      send: this.initiator ? c1 : c2,
      receive: this.initiator ? c2 : c1,
      remoteStatic: this.rs,
      handshakeHash: this.symmetric.handshakeHash(),
    }
  }

  private mixToken(token: 'ee' | 'es' | 'se'): void {
    const need = <T>(value: T | null): T => {
      if (value === null) throw new NoiseError(`missing key for ${token}`)
      return value
    }
    // For "es" the initiator uses its ephemeral with the responder's static;
    // the responder mirrors it. "se" is the reverse.
    switch (token) {
      case 'ee':
        this.symmetric.mixKey(dh(need(this.e), need(this.re)))
        break
      case 'es':
        this.symmetric.mixKey(this.initiator ? dh(need(this.e), need(this.rs)) : dh(this.s, need(this.re)))
        break
      case 'se':
        this.symmetric.mixKey(this.initiator ? dh(this.s, need(this.re)) : dh(need(this.e), need(this.rs)))
        break
    }
  }
}
