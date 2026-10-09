// The client side of pairing: handshake with a runtime it does not know yet,
// prove the one-time secret, check the runtime's proof and pin its key.

import {
  fingerprint,
  networkIdOf,
  openSecureChannel,
  SecureChannelError,
  type KeyPair,
  type MessagePortLike,
  type SecureChannel,
} from '../../security/contract'
import {
  clientProof,
  decodePairMessage,
  encodePairMessage,
  proofFromWire,
  proofToWire,
  verifyRuntimeProof,
  type PairRejectReason,
} from '../contract'
import type { KnownRuntimes } from './knownRuntimes'

export interface PairTarget {
  runtimeId: string
  secret: Uint8Array
  /** From a QR payload; a typed code has none. */
  fingerprint?: string
}

export interface PairOptions {
  deviceKeys: KeyPair
  deviceName: string
  target: PairTarget
  pins: Pick<KnownRuntimes, 'pin'>
  timeoutMs?: number
}

export class PairingError extends SecureChannelError {
  constructor(
    message: string,
    readonly reason: PairRejectReason | 'id-mismatch' | 'fingerprint-mismatch' | 'bad-runtime-proof' | 'timeout' | 'closed',
  ) {
    super(message)
  }
}

/** A failed pairing in words: why the runtime said no, or that it could not
 *  be reached. Shells that pair in another process send this text across. */
export function pairingErrorMessage(err: unknown): string {
  if (err instanceof PairingError) {
    switch (err.reason) {
      case 'fingerprint-mismatch':
      case 'id-mismatch': return 'The workspace that answered is not the one in the code.'
      case 'timeout': return 'The workspace did not answer in time.'
      case 'closed': return 'The workspace closed the connection.'
      case 'bad-runtime-proof': return 'The workspace could not prove it knows the code.'
      default: return 'The code was refused. Codes work once and expire after 10 minutes; ask for a new one.'
    }
  }
  return 'Could not reach the workspace. Check that it is served and that this device is on its network or online, then try again.'
}

/** Pairs and returns the open channel, ready for the protocol `hello`. */
export async function pairWithRuntime(port: MessagePortLike, options: PairOptions): Promise<SecureChannel> {
  const { target } = options
  const channel = await openSecureChannel(port, {
    role: 'initiator',
    staticKeys: options.deviceKeys,
    handshakeTimeoutMs: options.timeoutMs,
  })
  const abort = (error: PairingError): never => {
    channel.close(error)
    throw error
  }
  if (networkIdOf(channel.remoteStatic) !== target.runtimeId) {
    abort(new PairingError('runtime key does not match the runtime id', 'id-mismatch'))
  }
  if (target.fingerprint && fingerprint(channel.remoteStatic) !== target.fingerprint) {
    abort(new PairingError('runtime key does not match the pairing code', 'fingerprint-mismatch'))
  }

  const answered = nextFrame(channel, options.timeoutMs ?? 30_000)
  channel.send(
    encodePairMessage({
      type: 'pair',
      deviceName: options.deviceName,
      proof: proofToWire(clientProof(target.secret, channel.handshakeHash)),
    }),
  )
  const frame = await answered
  if (frame === 'timeout') return abort(new PairingError('runtime did not answer', 'timeout'))
  if (frame === 'closed') throw new PairingError('runtime closed the connection', 'closed')
  const answer = decodePairMessage(frame)
  if (!answer || answer.type === 'pair') return abort(new PairingError('unexpected answer', 'malformed'))
  if (answer.type === 'pair-rejected') return abort(new PairingError(`pairing rejected: ${answer.reason}`, answer.reason))
  if (!verifyRuntimeProof(target.secret, channel.handshakeHash, proofFromWire(answer.proof))) {
    return abort(new PairingError('runtime proof is wrong', 'bad-runtime-proof'))
  }
  await options.pins.pin(target.runtimeId, channel.remoteStatic)
  return channel
}

function nextFrame(channel: SecureChannel, timeoutMs: number): Promise<Uint8Array | 'timeout' | 'closed'> {
  return new Promise((resolve) => {
    const finish = (value: Uint8Array | 'timeout' | 'closed') => {
      clearTimeout(timer)
      offFrame()
      offClose()
      resolve(value)
    }
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    const offFrame = channel.onFrame((frame) => finish(frame))
    const offClose = channel.onClose(() => finish('closed'))
  })
}

