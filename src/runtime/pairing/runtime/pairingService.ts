// The runtime side of pairing: one-time secrets, the paired device list, the
// pair message handler and revocation.

import { randomBytes as nobleRandomBytes } from '@noble/hashes/utils.js'
import type { CapabilityImpl } from '@kernel/rpc/runtime'
import { bytesToHex, fingerprint, hexToBytes, type SecureChannel } from '../../security/contract'
import type { PeerPolicy } from '../../security/runtime'
import {
  cleanDeviceName,
  decodePairMessage,
  encodePairingUri,
  encodePairMessage,
  formatPairingCode,
  PAIRING_SECRET_BYTES,
  PAIRING_SECRET_TTL_MS,
  proofFromWire,
  proofToWire,
  runtimeProof,
  verifyClientProof,
  type CreatedSecret,
  type PairAnswer,
  type PairedDevice,
  type PairingMode,
  type pairingCapability,
} from '../contract'
import type { PairingsFile, PairingsStore } from './pairingsFile'

export interface PairingServiceOptions {
  runtimeId: string
  runtimePublicKey: Uint8Array
  store: PairingsStore
  /** LAN addresses (`host:port`) to put in the QR payload. */
  addresses?: () => string[]
  now?: () => number
  randomBytes?: (length: number) => Uint8Array
  /** How long an unknown key has to send `pair`. */
  pairTimeoutMs?: number
}

interface LiveSecret {
  secret: Uint8Array
  expiresAt: number
}

export class PairingService implements PeerPolicy {
  private secrets: LiveSecret[] = []
  private readonly revokeListeners = new Set<(publicKey: string) => void>()
  private readonly listListeners = new Set<(devices: PairedDevice[]) => void>()
  private readonly now: () => number
  private readonly random: (length: number) => Uint8Array

  constructor(private readonly options: PairingServiceOptions) {
    this.now = options.now ?? Date.now
    this.random = options.randomBytes ?? nobleRandomBytes
  }

  createSecret(mode: PairingMode): CreatedSecret {
    const secret = this.random(PAIRING_SECRET_BYTES)
    const expiresAt = this.now() + PAIRING_SECRET_TTL_MS
    this.secrets = [...this.liveSecrets(), { secret, expiresAt }]
    const { runtimeId, runtimePublicKey } = this.options
    return {
      uri: encodePairingUri({
        runtimeId,
        fingerprint: fingerprint(runtimePublicKey),
        secret,
        mode,
        addresses: this.options.addresses?.() ?? [],
      }),
      code: formatPairingCode({ runtimeId, secret }),
      expiresAt,
    }
  }

  list(): PairedDevice[] {
    return this.options.store.get().devices.map((device) => ({
      ...device,
      fingerprint: fingerprint(hexToBytes(device.publicKey)),
    }))
  }

  isPaired(publicKey: Uint8Array): boolean {
    const hex = bytesToHex(publicKey)
    return this.options.store.get().devices.some((device) => device.publicKey === hex)
  }

  markSeen(publicKey: Uint8Array): void {
    const hex = bytesToHex(publicKey)
    const now = this.now()
    this.update((file) => ({
      devices: file.devices.map((device) => (device.publicKey === hex ? { ...device, lastSeen: now } : device)),
    }))
  }

  /** Removes the device and tells listeners to drop its live connections. */
  revoke(deviceKey: string): { removed: boolean } {
    const hex = deviceKey.toLowerCase()
    let removed = false
    this.update((file) => {
      const devices = file.devices.filter((device) => device.publicKey !== hex)
      removed = devices.length !== file.devices.length
      return { devices }
    })
    if (removed) for (const listener of this.revokeListeners) listener(hex)
    return { removed }
  }

  /** Every change of the device list (a device paired, seen or removed). */
  watch(listener: (devices: PairedDevice[]) => void): () => void {
    this.listListeners.add(listener)
    return () => this.listListeners.delete(listener)
  }

  private update(fn: (file: PairingsFile) => PairingsFile): void {
    this.options.store.update(fn)
    const devices = this.list()
    for (const listener of [...this.listListeners]) listener(devices)
  }

  /** The daemon closes connections of a revoked key here. */
  onRevoked(listener: (publicKey: string) => void): () => void {
    this.revokeListeners.add(listener)
    return () => this.revokeListeners.delete(listener)
  }

  /**
   * The one attempt an unknown key gets: read `pair`, check the proof against
   * the live secrets, answer, store the device and burn the secret. A wrong
   * proof burns every live secret, since the request does not say which one
   * it was for.
   */
  async pairUnknown(channel: SecureChannel): Promise<boolean> {
    const frame = await firstFrame(channel, this.options.pairTimeoutMs ?? 30_000)
    if (!frame) return false
    const request = decodePairMessage(frame)
    // Not the pairing protocol at all: a client whose key is not (or no
    // longer) paired saying hello. The transport tells it it was refused.
    if (!request) return false
    if (request.type !== 'pair') return this.answer(channel, { type: 'pair-rejected', reason: 'malformed' })

    const live = this.liveSecrets()
    if (live.length === 0) return this.answer(channel, { type: 'pair-rejected', reason: 'no-secret' })
    const proof = proofFromWire(request.proof)
    const match = live.find((entry) => verifyClientProof(entry.secret, channel.handshakeHash, proof))
    if (!match) {
      this.secrets = []
      return this.answer(channel, { type: 'pair-rejected', reason: 'invalid-proof' })
    }

    this.secrets = live.filter((entry) => entry !== match)
    const hex = bytesToHex(channel.remoteStatic)
    const now = this.now()
    const name = cleanDeviceName(request.deviceName)
    this.update((file) => ({
      devices: [...file.devices.filter((device) => device.publicKey !== hex), { publicKey: hex, name, pairedAt: now, lastSeen: now }],
    }))
    return this.answer(channel, { type: 'paired', proof: proofToWire(runtimeProof(match.secret, channel.handshakeHash)) })
  }

  private answer(channel: SecureChannel, answer: PairAnswer): boolean {
    if (!channel.closed) channel.send(encodePairMessage(answer))
    return answer.type === 'paired'
  }

  private liveSecrets(): LiveSecret[] {
    const now = this.now()
    return this.secrets.filter((entry) => entry.expiresAt > now)
  }
}

/** Handlers for the `pairing` capability. */
export function pairingCapabilityImpl(service: PairingService): CapabilityImpl<typeof pairingCapability> {
  return {
    createSecret: ({ mode }) => service.createSecret(mode),
    list: () => service.list(),
    watch: (_params, sink) => {
      sink.emit(service.list())
      return service.watch((devices) => sink.emit(devices))
    },
    revoke: ({ deviceKey }) => service.revoke(deviceKey),
  }
}

function firstFrame(channel: SecureChannel, timeoutMs: number): Promise<Uint8Array | null> {
  if (channel.closed) return Promise.resolve(null)
  return new Promise((resolve) => {
    const finish = (frame: Uint8Array | null) => {
      clearTimeout(timer)
      offFrame()
      offClose()
      resolve(frame)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    const offFrame = channel.onFrame((frame) => finish(frame))
    const offClose = channel.onClose(() => finish(null))
  })
}
