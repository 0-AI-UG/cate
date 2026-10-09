import type { ByteDuplex } from '@kernel/rpc/contract'
import type { SecureChannel } from './channel'

/** A secure channel as a message-mode byte pipe for `framePortOver(duplex, 'message')`. */
export function secureChannelDuplex(channel: SecureChannel): ByteDuplex {
  return {
    // Like any closed pipe, a closed channel drops writes: its close tears
    // the connection down, and the sender (a runtime publishing to every
    // client) must not fail because one peer just left.
    write: (bytes) => { if (!channel.closed) channel.send(bytes) },
    onData: (listener) => { channel.onFrame(listener) },
    onClose: (listener) => { channel.onClose((error) => listener(error?.message)) },
    close: (reason) => channel.close(reason ? new Error(reason) : undefined),
  }
}
