import { channelStream, defineCapability, method } from '@kernel/rpc/contract'
import type { SameNetworkProblem } from '../../transports/contract'
import type { PairingMode } from './payload'

/** How a device got in the first time: it paired with a one-time code over
 *  the network, or it connected as a user of the runtime's machine (the
 *  local socket, or a bridge over SSH or WSL). Either way it is a known
 *  device afterwards, on every transport (7.6). */
export type DeviceAdmission = 'pairing' | 'machineUser'

/** A device that has opened this workspace. */
export interface WorkspaceDevice {
  /** hex X25519 public key */
  publicKey: string
  fingerprint: string
  name: string
  admittedBy: DeviceAdmission
  addedAt: number
  lastSeen: number
}

/** A hex X25519 public key, as devices.json and a client hello carry it. */
export function isDeviceKey(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

export interface CreatedSecret {
  /** `cate://pair?...`, shown as a QR code. */
  uri: string
  /** The typed form, groups of four. */
  code: string
  expiresAt: number
  /** A code for the same network only, on a machine that devices on its
   *  network could not reach: say so before anyone scans it. */
  sameNetworkProblem?: SameNetworkProblem
}

/** What to tell the person about a same-network code that will not work. */
export function sameNetworkProblemMessage(problem: SameNetworkProblem): string {
  return problem === 'publicNetwork'
    ? 'This network keeps devices apart.'
    : 'This machine has no local network address.'
}

export const pairingCapability = defineCapability('pairing', {
  methods: {
    /** `acknowledged`: the person confirmed, this time, that whoever joins
     *  can use this computer as them. Refused without it. */
    createSecret: method<{ mode: PairingMode; acknowledged: true }, CreatedSecret>({ mutates: true }),
    list: method<void, WorkspaceDevice[]>(),
    revoke: method<{ deviceKey: string }, { removed: boolean }>({ mutates: true }),
  },
  streams: {
    /** The device list: a snapshot, then the whole list after every change
     *  (paired, connected, removed). */
    watch: channelStream<void, WorkspaceDevice[], WorkspaceDevice[]>(),
  },
})

declare module '@kernel/rpc/contract' {
  interface CapabilityRegistry {
    pairing: typeof pairingCapability
  }
}
