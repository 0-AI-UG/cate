import type { MessagePortLike } from '../../security/contract'

/** The listener half of a message port over a socket-like object. Messages
 *  that arrive before the first listener are held for it, since the peer may
 *  speak before the consumer attaches. */
export interface PortCore {
  readonly closed: boolean
  deliver(message: Uint8Array): void
  finish(error?: Error): void
  port(send: (message: Uint8Array) => void, close: () => void): MessagePortLike
}

export function createPortCore(): PortCore {
  const messageListeners = new Set<(message: Uint8Array) => void>()
  const closeListeners = new Set<(error?: Error) => void>()
  let closed = false
  let closeError: Error | undefined
  let early: Uint8Array[] | null = []

  const flushEarly = () => {
    while (early && early.length > 0 && !closed) {
      const message = early.shift()!
      for (const listener of messageListeners) listener(message)
    }
    early = null
  }

  const core: PortCore = {
    get closed() { return closed },
    deliver(message) {
      if (closed) return
      if (early) early.push(message)
      else for (const listener of messageListeners) listener(message)
    },
    finish(error) {
      if (closed) return
      closed = true
      closeError = error
      early = null
      for (const listener of closeListeners) listener(error)
      closeListeners.clear()
      messageListeners.clear()
    },
    port: (send, close) => ({
      send(message) {
        if (closed) throw new Error('connection closed')
        send(message)
      },
      close() {
        if (closed) return
        close()
        core.finish()
      },
      onMessage(listener) {
        messageListeners.add(listener)
        if (early) queueMicrotask(flushEarly)
        return () => messageListeners.delete(listener)
      },
      onClose(listener) {
        if (closed) {
          queueMicrotask(() => listener(closeError))
          return () => {}
        }
        closeListeners.add(listener)
        return () => closeListeners.delete(listener)
      },
    }),
  }
  return core
}
