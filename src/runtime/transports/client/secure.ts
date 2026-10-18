// Opens the secure channel to a paired runtime on a network connection and
// hands back its rpc frames: the pinned key checked, then the `connect`
// opening, then the protocol. Pairing opens with `pair` instead
// (`pairWithRuntime`).

import type { FramePort } from '@kernel/rpc/contract'
import { connectToRuntime, type RuntimePins } from '../../security/client'
import type { KeyPair, MessagePortLike, SecureChannel } from '../../security/contract'
import { encodeOpening } from '../../pairing/contract'
import { secureFramePort } from '../contract'

export interface SecureConnectOptions {
  deviceKeys: KeyPair
  runtimeId: string
  pins: RuntimePins
  timeoutMs?: number
}

export interface SecureConnection {
  channel: SecureChannel
  /** Attach an `RpcClient` here; its hello must carry this device's key fingerprint. */
  frames: FramePort
}

export async function openSecureConnection(port: MessagePortLike, options: SecureConnectOptions): Promise<SecureConnection> {
  const channel = await connectToRuntime(port, {
    deviceKeys: options.deviceKeys,
    runtimeId: options.runtimeId,
    pins: options.pins,
    handshakeTimeoutMs: options.timeoutMs,
  })
  channel.send(encodeOpening({ type: 'connect' }))
  return { channel, frames: secureFramePort(channel) }
}
