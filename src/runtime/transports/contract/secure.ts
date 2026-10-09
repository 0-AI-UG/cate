import { framePortOver, type FramePort } from '@kernel/rpc/contract'
import { secureChannelDuplex, type SecureChannel } from '../../security/contract'

/** The rpc frames of a network connection, one frame per Noise-protected message. */
export function secureFramePort(channel: SecureChannel): FramePort {
  return framePortOver(secureChannelDuplex(channel), 'message')
}

/** The `data` of the hello refusal an unpaired (never paired or removed)
 *  device gets, so its client can offer to pair again. */
export interface UnpairedRefusal {
  unpaired: true
}

export function isUnpairedRefusal(data: unknown): boolean {
  return (data as Partial<UnpairedRefusal> | null | undefined)?.unpaired === true
}
