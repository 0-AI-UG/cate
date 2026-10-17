import type { MessagePortLike } from './channel'

/** Two connected in-memory ports, delivering asynchronously in order. For tests. */
export function createMemoryPortPair(): [MemoryPort, MemoryPort] {
  const a = new MemoryPort()
  const b = new MemoryPort()
  a.peer = b
  b.peer = a
  return [a, b]
}

export class MemoryPort implements MessagePortLike {
  peer: MemoryPort | null = null
  closed = false
  /** Rewrites outgoing messages; tests use it to tamper. */
  intercept: ((message: Uint8Array) => Uint8Array | null) | null = null
  readonly sent: Uint8Array[] = []
  private readonly messageListeners = new Set<(message: Uint8Array) => void>()
  private readonly closeListeners = new Set<(error?: Error) => void>()

  send(message: Uint8Array): void {
    if (this.closed) throw new Error('port closed')
    const out = this.intercept ? this.intercept(message) : message
    if (!out) return
    this.sent.push(out)
    const peer = this.peer
    queueMicrotask(() => {
      if (peer && !peer.closed) for (const listener of peer.messageListeners) listener(out.slice())
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const listener of this.closeListeners) listener()
    const peer = this.peer
    queueMicrotask(() => peer?.close())
  }

  onMessage(listener: (message: Uint8Array) => void): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }
}
