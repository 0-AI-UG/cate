// What a shell provides so the client core can reach runtimes: raw byte
// pipes. Framing, the protocol and (for the network) the security layer are
// the client's.

import type { ByteDuplex } from '@kernel/rpc/contract'
import type { NetworkEndpoint, NetworkTarget } from '@runtime/transports/contract'

export type ConnectionTarget =
  | { kind: 'local'; root: string }
  | ({ kind: 'network' } & NetworkTarget)

export type ConnectionKind = ConnectionTarget['kind']

export interface ShellTransports {
  /** Computes the runtimeId of `root`, connects to its local socket and
   *  starts the runtime when nothing answers (7.3). A stream pipe. */
  dialLocal(root: string): Promise<ByteDuplex>
  /** A message pipe to a paired runtime, already inside the security layer.
   *  Filled in by the network wave; a shell without it reaches local
   *  runtimes only. */
  dialNetwork?(target: NetworkTarget): Promise<ByteDuplex>
  /** A TCP connection to a loopback port of this machine (12.3). */
  dialLoopbackTcp(port: number): Promise<ByteDuplex>
  /** Pairs with the runtime behind a `cate://pair` link or a typed code
   *  (7.7), where the device key lives, and pins the runtime's key. A shell
   *  that cannot join network workspaces leaves it out; one without a
   *  privileged process implements it with `pairWithRuntime` from
   *  runtime/pairing over a raw pre-security port. */
  pair?(link: string): Promise<PairedRuntime>
}

/** A runtime this device just paired with. */
export interface PairedRuntime {
  runtimeId: string
  /** Where it was reached; stored with the paired workspace. */
  endpoints: NetworkEndpoint[]
  /** Its static key, pinned in `known-runtimes`. */
  publicKey: Uint8Array
}
