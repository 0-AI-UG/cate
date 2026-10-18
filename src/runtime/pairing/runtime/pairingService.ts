// The runtime side of pairing: one-time secrets, the workspace's device list
// (every device that has opened it, however it got in), the pair message
// handler and revocation.

import { randomBytes as nobleRandomBytes } from '@noble/hashes/utils.js'
import { RpcError, type DeviceInfo, type HelloMessage } from '@kernel/rpc/contract'
import type { CapabilityImpl } from '@kernel/rpc/runtime'
import { base32Encode, bytesToHex, fingerprint, hexToBytes, networkIdOf, nextFrame, type SecureChannel } from '../../security/contract'
import {
  cleanDeviceName,
  isDeviceKey,
  decodeOpening,
  encodePairAnswer,
  encodePairingUri,
  formatPairingCode,
  PAIRING_SECRET_BYTES,
  PAIRING_SECRET_TTL_MS,
  OPENING_TIMEOUT_MS,
  SECRET_ID_CHARS,
  proofFromWire,
  proofToWire,
  runtimeProof,
  verifyClientProof,
  type Admission,
  type CreatedSecret,
  type PairAnswer,
  type PairingMode,
  type PairRejectReason,
  type PairRequest,
  type pairingCapability,
  type WorkspaceDevice,
} from '../contract'
import type { SameNetworkProblem } from '../../transports/contract'
import type { DevicesFile, DevicesStore } from './devicesFile'

export interface PairingServiceOptions {
  /** The runtime's static key; codes carry its network id. */
  runtimePublicKey: Uint8Array
  store: DevicesStore
  /** LAN addresses (`host:port`) to put in the QR payload. */
  addresses?: () => string[]
  /** Why devices could not reach this machine on the same network, if so. */
  sameNetworkProblem?: () => SameNetworkProblem | null
  now?: () => number
  randomBytes?: (length: number) => Uint8Array
  /** How long a connection has to send its opening. */
  openingTimeoutMs?: number
}

interface LiveSecret {
  id: string
  secret: Uint8Array
  expiresAt: number
}

export class PairingService {
  private secrets: LiveSecret[] = []
  private readonly revokeListeners = new Set<(publicKey: string) => void>()
  private readonly listListeners = new Set<(devices: WorkspaceDevice[]) => void>()
  private readonly now: () => number
  private readonly random: (length: number) => Uint8Array

  constructor(private readonly options: PairingServiceOptions) {
    this.now = options.now ?? Date.now
    this.random = options.randomBytes ?? nobleRandomBytes
    // A device removed by editing devices.json is revoked like one removed
    // in the app: its live connections drop.
    let known = new Set(options.store.get().devices.map((device) => device.publicKey))
    options.store.subscribe((next, origin) => {
      const now = new Set(next.devices.map((device) => device.publicKey))
      const removed = [...known].filter((key) => !now.has(key))
      known = now
      if (origin !== 'external') return
      for (const key of removed) for (const listener of this.revokeListeners) listener(key)
      const devices = this.list()
      for (const listener of this.listListeners) listener(devices)
    })
  }

  createSecret(mode: PairingMode): CreatedSecret {
    const live = this.liveSecrets()
    let id: string
    do id = base32Encode(this.random(3)).slice(0, SECRET_ID_CHARS)
    while (live.some((entry) => entry.id === id))
    const secret = this.random(PAIRING_SECRET_BYTES)
    const expiresAt = this.now() + PAIRING_SECRET_TTL_MS
    this.secrets = [...live, { id, secret, expiresAt }]
    const { runtimePublicKey } = this.options
    const runtimeId = networkIdOf(runtimePublicKey)
    const problem = mode === 'sameNetwork' ? this.options.sameNetworkProblem?.() ?? null : null
    return {
      uri: encodePairingUri({
        runtimeId,
        fingerprint: fingerprint(runtimePublicKey),
        secretId: id,
        secret,
        mode,
        addresses: this.options.addresses?.() ?? [],
      }),
      code: formatPairingCode({ runtimeId, secretId: id, secret }),
      expiresAt,
      ...(problem ? { sameNetworkProblem: problem } : {}),
    }
  }

  list(): WorkspaceDevice[] {
    return this.options.store.get().devices.map((device) => ({
      ...device,
      fingerprint: fingerprint(hexToBytes(device.publicKey)),
    }))
  }

  isPaired(publicKey: Uint8Array): boolean {
    const hex = bytesToHex(publicKey)
    return this.options.store.get().devices.some((device) => device.publicKey === hex)
  }

  /**
   * A client connected as `device`. A known device is marked seen under the
   * name it gives now; an unknown one connected as a user of this machine
   * (a network connection with an unknown key never says hello), so it is
   * added. A connection without a key (`cate serve`) is no device.
   */
  connected(device: DeviceInfo): void {
    if (!isDeviceKey(device.publicKey)) return
    const hex = device.publicKey
    const name = cleanDeviceName(device.name)
    const now = this.now()
    this.update((file) => {
      const known = file.devices.some((entry) => entry.publicKey === hex)
      return {
        devices: known
          ? file.devices.map((entry) => (entry.publicKey === hex ? { ...entry, name, lastSeen: now } : entry))
          : [...file.devices, { publicKey: hex, name, admittedBy: 'machineUser', addedAt: now, lastSeen: now }],
      }
    })
  }

  /** Removes the device and tells listeners to drop its live connections,
   *  whatever carried them. One admitted as a user of this machine comes
   *  back when it connects again. */
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
  watch(listener: (devices: WorkspaceDevice[]) => void): () => void {
    this.listListeners.add(listener)
    return () => this.listListeners.delete(listener)
  }

  private update(fn: (file: DevicesFile) => DevicesFile): void {
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
   * Reads a network connection's opening and acts on it (architecture 7.6):
   * `connect` is admitted for a known key and refused for any other; `pair`
   * is checked against the live secret it names whether the key is known or
   * not (a device that lost the runtime's pin pairs again), answered, and
   * stores the device and burns the secret when it holds. A wrong proof or
   * an unknown id burns nothing: the id is short enough to walk, so burning
   * on a wrong proof would let anyone on the network spoil a code, and
   * guessing the 80-bit secret online is hopeless anyway.
   */
  async admit(channel: SecureChannel): Promise<Admission> {
    const frame = await nextFrame(channel, this.options.openingTimeoutMs ?? OPENING_TIMEOUT_MS)
    const opening = frame instanceof Uint8Array ? decodeOpening(frame) : null
    if (!opening) return { kind: 'no-opening' }
    if (opening.type === 'connect') return this.isPaired(channel.remoteStatic) ? { kind: 'connect' } : { kind: 'unpaired' }
    return this.pair(channel, opening)
  }

  private pair(channel: SecureChannel, request: PairRequest): Admission {
    const live = this.liveSecrets()
    const match = live.find((entry) => entry.id === request.secretId)
    if (!match) return this.reject(channel, 'no-secret')
    if (!verifyClientProof(match.secret, channel.handshakeHash, proofFromWire(request.proof))) {
      return this.reject(channel, 'invalid-proof')
    }
    this.secrets = live.filter((entry) => entry !== match)

    const hex = bytesToHex(channel.remoteStatic)
    const now = this.now()
    const deviceName = cleanDeviceName(request.deviceName)
    this.update((file) => ({
      devices: [...file.devices.filter((device) => device.publicKey !== hex), { publicKey: hex, name: deviceName, admittedBy: 'pairing', addedAt: now, lastSeen: now }],
    }))
    this.answer(channel, { type: 'paired', proof: proofToWire(runtimeProof(match.secret, channel.handshakeHash)) })
    return { kind: 'paired', deviceName }
  }

  private reject(channel: SecureChannel, reason: PairRejectReason): Admission {
    this.answer(channel, { type: 'pair-rejected', reason })
    return { kind: 'pair-rejected', reason }
  }

  private answer(channel: SecureChannel, answer: PairAnswer): void {
    if (!channel.closed) channel.send(encodePairAnswer(answer))
  }

  private liveSecrets(): LiveSecret[] {
    const now = this.now()
    return this.secrets.filter((entry) => entry.expiresAt > now)
  }
}

/** Handlers for the `pairing` capability. */
export function pairingCapabilityImpl(service: PairingService): CapabilityImpl<typeof pairingCapability> {
  return {
    createSecret: ({ mode, acknowledged }) => {
      if (acknowledged !== true) {
        throw new RpcError('rejected', 'The person sharing must confirm that whoever joins can use this computer as them')
      }
      return service.createSecret(mode)
    },
    list: () => service.list(),
    watch: (_params, sink) => {
      let rev = 0
      sink.emit({ kind: 'snapshot', rev, snapshot: service.list() })
      return service.watch((devices) => sink.emit({ kind: 'change', rev: ++rev, change: devices }))
    },
    revoke: ({ deviceKey }) => service.revoke(deviceKey),
  }
}
