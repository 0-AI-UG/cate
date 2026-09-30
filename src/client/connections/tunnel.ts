// A `tunnel.connect` stream as a byte pipe, for loopback routing over a
// network connection (12.3).

import type { ByteDuplex, Subscription } from '@kernel/rpc/contract'
import type { TunnelEvent } from '@runtime/tunnel/contract'

/** Resolves once the runtime reports the TCP connection open; rejects when
 *  the stream ends before that. */
export function tunnelDuplex(sub: Subscription<TunnelEvent, void>): Promise<ByteDuplex> {
  return new Promise((resolve, reject) => {
    let opened = false
    let closed = false
    const closeListeners: ((reason?: string) => void)[] = []
    const finish = (reason?: string) => {
      if (closed) return
      closed = true
      for (const listener of closeListeners) listener(reason)
    }
    const duplex: ByteDuplex = {
      write: (bytes) => { if (!closed) sub.write(bytes) },
      onData: (listener) => { sub.onBytes(listener) },
      onClose: (listener) => { closeListeners.push(listener) },
      close: (reason) => {
        if (closed) return
        sub.cancel()
        finish(reason)
      },
    }
    sub.onEvent((event) => {
      if (event.kind !== 'open' || opened) return
      opened = true
      resolve(duplex)
    })
    sub.done.then(
      () => {
        if (!opened) reject(new Error('Tunnel closed before it opened'))
        finish()
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        if (!opened) reject(err instanceof Error ? err : new Error(message))
        finish(message)
      },
    )
  })
}
