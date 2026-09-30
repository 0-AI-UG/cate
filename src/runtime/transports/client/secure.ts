// Opens the secure channel on a network connection and hands back its rpc
// frames: by pinned key for a known runtime, or by the pairing exchange the
// first time.

import type { FramePort } from '@kernel/rpc/contract'
import { connectToRuntime, type RuntimePins } from '../../security/client'
import type { KeyPair, MessagePortLike, SecureChannel } from '../../security/contract'
import { pairWithRuntime, type KnownRuntimes, type PairTarget } from '../../pairing/client'
import { secureFramePort } from '../contract'

export type SecureOpen =
  | { kind: 'connect'; deviceKeys: KeyPair; runtimeId: string; pins: RuntimePins; timeoutMs?: number }
  | { kind: 'pair'; deviceKeys: KeyPair; deviceName: string; target: PairTarget; pins: Pick<KnownRuntimes, 'pin'>; timeoutMs?: number }

export interface SecureConnection {
  channel: SecureChannel
  /** Attach an `RpcClient` here; its hello must carry this device's key fingerprint. */
  frames: FramePort
}

export async function openSecureConnection(port: MessagePortLike, how: SecureOpen): Promise<SecureConnection> {
  const channel = how.kind === 'connect'
    ? await connectToRuntime(port, {
      deviceKeys: how.deviceKeys,
      runtimeId: how.runtimeId,
      pins: how.pins,
      handshakeTimeoutMs: how.timeoutMs,
    })
    : await pairWithRuntime(port, {
      deviceKeys: how.deviceKeys,
      deviceName: how.deviceName,
      target: how.target,
      pins: how.pins,
      timeoutMs: how.timeoutMs,
    })
  return { channel, frames: secureFramePort(channel) }
}
