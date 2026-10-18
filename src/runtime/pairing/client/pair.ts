// The client side of pairing: handshake with a runtime it may not know yet,
// open with `pair` and the proof of the one-time secret, check the runtime's
// proof and pin its key. The connection ends there; the device then connects
// by key.

import {
  fingerprint,
  networkIdOf,
  nextFrame,
  openSecureChannel,
  SecureChannelError,
  type KeyPair,
  type MessagePortLike,
} from '../../security/contract'
import {
  clientProof,
  decodePairAnswer,
  encodeOpening,
  proofFromWire,
  proofToWire,
  verifyRuntimeProof,
  type PairRejectReason,
} from '../contract'
import type { KnownRuntimes } from './knownRuntimes'

export interface PairTarget {
  runtimeId: string
  secretId: string
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
    readonly reason: PairRejectReason | 'malformed' | 'id-mismatch' | 'fingerprint-mismatch' | 'bad-runtime-proof' | 'timeout' | 'closed',
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
      default: return 'The code was refused or expired. Ask for a new one.'
    }
  }
  return 'Could not reach the workspace.'
}

/** Pairs, pins the runtime's key and returns it; the connection is closed. */
export async function pairWithRuntime(port: MessagePortLike, options: PairOptions): Promise<Uint8Array> {
  const { target } = options
  const channel = await openSecureChannel(port, {
    role: 'initiator',
    staticKeys: options.deviceKeys,
    handshakeTimeoutMs: options.timeoutMs,
  })
  try {
    if (networkIdOf(channel.remoteStatic) !== target.runtimeId) {
      throw new PairingError('runtime key does not match the runtime id', 'id-mismatch')
    }
    if (target.fingerprint && fingerprint(channel.remoteStatic) !== target.fingerprint) {
      throw new PairingError('runtime key does not match the pairing code', 'fingerprint-mismatch')
    }

    const answered = nextFrame(channel, options.timeoutMs ?? 30_000)
    channel.send(
      encodeOpening({
        type: 'pair',
        deviceName: options.deviceName,
        secretId: target.secretId,
        proof: proofToWire(clientProof(target.secret, channel.handshakeHash)),
      }),
    )
    const frame = await answered
    if (frame === 'timeout') throw new PairingError('runtime did not answer', 'timeout')
    if (frame === 'closed') throw new PairingError('runtime closed the connection', 'closed')
    const answer = decodePairAnswer(frame)
    if (!answer) throw new PairingError('unexpected answer', 'malformed')
    if (answer.type === 'pair-rejected') throw new PairingError(`pairing rejected: ${answer.reason}`, answer.reason)
    if (!verifyRuntimeProof(target.secret, channel.handshakeHash, proofFromWire(answer.proof))) {
      throw new PairingError('runtime proof is wrong', 'bad-runtime-proof')
    }
    await options.pins.pin(target.runtimeId, channel.remoteStatic)
    return channel.remoteStatic
  } finally {
    channel.close()
  }
}
