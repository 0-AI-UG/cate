// Runtime side of the security layer: the handshake of an incoming network
// connection. What the peer may do after it (pair, connect, nothing) is
// decided by its opening (runtime/pairing), not here.

import { openSecureChannel, type KeyPair, type MessagePortLike, type SecureChannel } from '../contract'

export interface AcceptOptions {
  runtimeKeys: KeyPair
  handshakeTimeoutMs?: number
}

/** Largest frame from a peer not yet admitted: enough for an opening or a
 *  `hello`, raised to the default once the peer is admitted. */
export const UNPAIRED_MAX_FRAME = 16 * 1024

/** How long a peer gets to finish its handshake: Noise XX is one and a half
 *  round trips, and an unproven peer holds a slot meanwhile. */
export const PEER_HANDSHAKE_TIMEOUT_MS = 5_000

/** Completes the handshake as responder; the channel takes frames of at most
 *  `UNPAIRED_MAX_FRAME` until the caller admits the peer. */
export function acceptPeer(port: MessagePortLike, options: AcceptOptions): Promise<SecureChannel> {
  return openSecureChannel(port, {
    role: 'responder',
    staticKeys: options.runtimeKeys,
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? PEER_HANDSHAKE_TIMEOUT_MS,
    maxFrameBytes: UNPAIRED_MAX_FRAME,
  })
}
