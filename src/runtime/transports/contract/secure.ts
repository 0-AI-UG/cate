import { framePortOver, type FramePort } from '@kernel/rpc/contract'
import { secureChannelDuplex, type SecureChannel } from '../../security/contract'

/** The rpc frames of a network connection, one frame per Noise-protected message. */
export function secureFramePort(channel: SecureChannel): FramePort {
  return framePortOver(secureChannelDuplex(channel), 'message')
}
