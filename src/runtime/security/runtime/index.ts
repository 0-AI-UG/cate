// Runtime side of the security layer: accept a network connection, admit
// paired devices, and give an unknown key exactly one pairing attempt.

import {
  openSecureChannel,
  SecureChannelError,
  type KeyPair,
  type MessagePortLike,
  type SecureChannel,
} from '../contract'

export interface PeerPolicy {
  isPaired(publicKey: Uint8Array): boolean | Promise<boolean>
  /**
   * The one attempt an unknown key gets (the `pair` message). Resolves true
   * when the device is now paired; anything else closes the connection.
   */
  pairUnknown(channel: SecureChannel): Promise<boolean>
}

export interface AcceptOptions {
  runtimeKeys: KeyPair
  policy: PeerPolicy
  handshakeTimeoutMs?: number
}

export class UnpairedPeerError extends SecureChannelError {}

/** Resolves with a channel from a paired device, or rejects after closing it. */
export async function acceptPeer(port: MessagePortLike, options: AcceptOptions): Promise<SecureChannel> {
  const channel = await openSecureChannel(port, {
    role: 'responder',
    staticKeys: options.runtimeKeys,
    handshakeTimeoutMs: options.handshakeTimeoutMs,
  })
  if (await options.policy.isPaired(channel.remoteStatic)) return channel
  let paired = false
  try {
    paired = await options.policy.pairUnknown(channel)
  } catch {
    paired = false
  }
  if (paired && !channel.closed) return channel
  const error = new UnpairedPeerError('unknown device key')
  channel.close(error)
  throw error
}
