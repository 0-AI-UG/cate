// Client side of the security layer: connect to a runtime whose key this
// device pinned when it paired.

import {
  bytesEqual,
  fingerprint,
  networkIdOf,
  openSecureChannel,
  SecureChannelError,
  type KeyPair,
  type MessagePortLike,
  type SecureChannel,
} from '../contract'

/** Pinned runtime keys by runtimeId (known-runtimes.json behind it). */
export interface RuntimePins {
  get(runtimeId: string): Promise<Uint8Array | undefined>
}

export class UnknownRuntimeError extends SecureChannelError {}
export class PinMismatchError extends SecureChannelError {}

export interface ConnectOptions {
  deviceKeys: KeyPair
  runtimeId: string
  pins: RuntimePins
  handshakeTimeoutMs?: number
}

/** Opens a channel as initiator and aborts unless the runtime's key is the pinned one. */
export async function connectToRuntime(port: MessagePortLike, options: ConnectOptions): Promise<SecureChannel> {
  const pinned = await options.pins.get(options.runtimeId)
  if (!pinned) {
    port.close()
    throw new UnknownRuntimeError(`runtime ${options.runtimeId} is not paired`)
  }
  const channel = await openSecureChannel(port, {
    role: 'initiator',
    staticKeys: options.deviceKeys,
    handshakeTimeoutMs: options.handshakeTimeoutMs,
  })
  if (!bytesEqual(channel.remoteStatic, pinned) || networkIdOf(channel.remoteStatic) !== options.runtimeId) {
    const error = new PinMismatchError(
      `runtime ${options.runtimeId} presented key ${fingerprint(channel.remoteStatic)}, pinned ${fingerprint(pinned)}`,
    )
    channel.close(error)
    throw error
  }
  return channel
}
