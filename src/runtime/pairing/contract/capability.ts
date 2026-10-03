import { defineCapability, method, stream } from '@kernel/rpc/contract'
import type { PairingMode } from './payload'

export interface PairedDevice {
  /** hex X25519 public key */
  publicKey: string
  fingerprint: string
  name: string
  pairedAt: number
  lastSeen: number
}

export interface CreatedSecret {
  /** `cate://pair?...`, shown as a QR code. */
  uri: string
  /** The typed form, groups of four. */
  code: string
  expiresAt: number
}

export const pairingCapability = defineCapability('pairing', {
  methods: {
    createSecret: method<{ mode: PairingMode }, CreatedSecret>({ mutates: true }),
    list: method<void, PairedDevice[]>(),
    revoke: method<{ deviceKey: string }, { removed: boolean }>({ mutates: true }),
  },
  streams: {
    /** The device list now and after every change (paired, seen, removed). */
    watch: stream<void, PairedDevice[]>(),
  },
})

declare module '@kernel/rpc/contract' {
  interface CapabilityRegistry {
    pairing: typeof pairingCapability
  }
}
