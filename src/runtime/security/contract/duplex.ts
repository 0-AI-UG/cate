import type { ByteDuplex } from '@kernel/rpc/contract'
import type { SecureChannel } from './channel'

/** A secure channel as a message-mode byte pipe for `framePortOver(duplex, 'message')`. */
export function secureChannelDuplex(channel: SecureChannel): ByteDuplex {
  return {
    write: (bytes) => channel.send(bytes),
    onData: (listener) => { channel.onFrame(listener) },
    onClose: (listener) => { channel.onClose((error) => listener(error?.message)) },
    close: (reason) => channel.close(reason ? new Error(reason) : undefined),
  }
}
