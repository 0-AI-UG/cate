// Runtime side of the security layer: accept a network connection, admit
// paired devices, and give an unknown key exactly one pairing attempt.

import {
  DEFAULT_MAX_FRAME,
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
  /** Last word to an unpaired key before its channel closes (the transport
   *  answers a client's hello with a refusal). */
  refuse?(channel: SecureChannel): void
}

export class UnpairedPeerError extends SecureChannelError {}

/** Largest frame from a key not yet known to be paired: enough for `pair`
 *  or a `hello`, raised to the default once the key is paired. */
export const UNPAIRED_MAX_FRAME = 16 * 1024

/** Resolves with a channel from a paired device, or rejects after closing it. */
export async function acceptPeer(port: MessagePortLike, options: AcceptOptions): Promise<SecureChannel> {
  const channel = await openSecureChannel(port, {
    role: 'responder',
    staticKeys: options.runtimeKeys,
    handshakeTimeoutMs: options.handshakeTimeoutMs,
    maxFrameBytes: UNPAIRED_MAX_FRAME,
  })
  if (await options.policy.isPaired(channel.remoteStatic)) {
    channel.setMaxFrameBytes(DEFAULT_MAX_FRAME)
    return channel
  }
  let paired = false
  try {
    paired = await options.policy.pairUnknown(channel)
  } catch {
    paired = false
  }
  if (paired && !channel.closed) {
    channel.setMaxFrameBytes(DEFAULT_MAX_FRAME)
    return channel
  }
  if (!channel.closed) options.refuse?.(channel)
  const error = new UnpairedPeerError('unknown device key')
  channel.close(error)
  throw error
}
