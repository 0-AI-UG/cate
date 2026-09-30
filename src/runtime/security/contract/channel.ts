// A Noise-secured frame channel over any ordered message port (a WebSocket, a
// WebRTC data channel). Portable: the port is injected, no I/O here.

import { concatBytes } from './encoding'
import type { KeyPair } from './keys'
import { CipherState, HandshakeState, NOISE_MAX_MESSAGE, NoiseError } from './noise'

/** An ordered, reliable, message-preserving transport. */
export interface MessagePortLike {
  send(message: Uint8Array): void
  close(): void
  onMessage(listener: (message: Uint8Array) => void): () => void
  onClose(listener: (error?: Error) => void): () => void
}

export interface SecureChannel {
  /** The peer's static public key, authenticated by the handshake. */
  readonly remoteStatic: Uint8Array
  readonly handshakeHash: Uint8Array
  send(frame: Uint8Array): void
  /** Frames received while no listener is attached are queued for the next one. */
  onFrame(listener: (frame: Uint8Array) => void): () => void
  onClose(listener: (error?: Error) => void): () => void
  close(error?: Error): void
  readonly closed: boolean
}

export interface SecureChannelOptions {
  role: 'initiator' | 'responder'
  staticKeys: KeyPair
  prologue?: Uint8Array
  handshakeTimeoutMs?: number
  /** Largest reassembled frame accepted; bigger frames close the channel. */
  maxFrameBytes?: number
}

export const SECURE_CHANNEL_PROLOGUE = new TextEncoder().encode('cate-secure-channel/1')
const TAGLEN = 16
// Each Noise message carries one header byte (1 = last chunk of a frame).
export const MAX_CHUNK = NOISE_MAX_MESSAGE - TAGLEN - 1
const LAST = 1
const MORE = 0
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_FRAME = 64 * 1024 * 1024

export class SecureChannelError extends Error {}

export function openSecureChannel(port: MessagePortLike, options: SecureChannelOptions): Promise<SecureChannel> {
  const handshake = new HandshakeState({
    initiator: options.role === 'initiator',
    staticKeys: options.staticKeys,
    prologue: options.prologue ?? SECURE_CHANNEL_PROLOGUE,
  })
  const maxFrame = options.maxFrameBytes ?? DEFAULT_MAX_FRAME

  return new Promise((resolve, reject) => {
    let channel: Channel | null = null
    let settled = false
    const cleanups: Array<() => void> = []
    const timer = setTimeout(() => fail(new SecureChannelError('handshake timed out')), options.handshakeTimeoutMs ?? DEFAULT_TIMEOUT_MS)

    function fail(error: Error): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const cleanup of cleanups) cleanup()
      port.close()
      reject(error)
    }

    function complete(): void {
      const result = handshake.finish()
      settled = true
      clearTimeout(timer)
      channel = new Channel(port, result.send, result.receive, result.remoteStatic, result.handshakeHash, maxFrame)
      resolve(channel)
    }

    cleanups.push(port.onClose((error) => {
      if (channel) channel.handlePortClose(error)
      else fail(error ?? new SecureChannelError('connection closed during handshake'))
    }))
    cleanups.push(port.onMessage((message) => {
      if (channel) {
        channel.handleMessage(message)
        return
      }
      if (settled) return
      try {
        handshake.readMessage(message)
        if (handshake.isMyTurn()) port.send(handshake.writeMessage())
        if (handshake.isComplete()) complete()
      } catch (error) {
        fail(error instanceof Error ? error : new SecureChannelError(String(error)))
      }
    }))

    try {
      if (handshake.isMyTurn()) port.send(handshake.writeMessage())
    } catch (error) {
      fail(error instanceof Error ? error : new SecureChannelError(String(error)))
    }
  })
}

class Channel implements SecureChannel {
  closed = false
  private readonly frameListeners = new Set<(frame: Uint8Array) => void>()
  private readonly closeListeners = new Set<(error?: Error) => void>()
  private queued: Uint8Array[] = []
  private chunks: Uint8Array[] = []
  private chunkBytes = 0

  constructor(
    private readonly port: MessagePortLike,
    private readonly sender: CipherState,
    private readonly receiver: CipherState,
    readonly remoteStatic: Uint8Array,
    readonly handshakeHash: Uint8Array,
    private readonly maxFrame: number,
  ) {}

  send(frame: Uint8Array): void {
    if (this.closed) throw new SecureChannelError('channel closed')
    let offset = 0
    do {
      const end = Math.min(offset + MAX_CHUNK, frame.length)
      const chunk = new Uint8Array(1 + end - offset)
      chunk[0] = end === frame.length ? LAST : MORE
      chunk.set(frame.subarray(offset, end), 1)
      this.port.send(this.sender.encryptWithAd(new Uint8Array(0), chunk))
      offset = end
    } while (offset < frame.length)
  }

  onFrame(listener: (frame: Uint8Array) => void): () => void {
    this.frameListeners.add(listener)
    // Queued frames go out on a microtask, one at a time, so a listener that
    // takes one frame and unsubscribes leaves the rest queued for the next.
    if (this.queued.length > 0) queueMicrotask(() => this.drain())
    return () => this.frameListeners.delete(listener)
  }

  private drain(): void {
    while (this.queued.length > 0 && this.frameListeners.size > 0 && !this.closed) {
      const frame = this.queued.shift()!
      for (const listener of [...this.frameListeners]) listener(frame)
    }
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  close(error?: Error): void {
    if (this.closed) return
    this.handlePortClose(error)
    this.port.close()
  }

  handlePortClose(error?: Error): void {
    if (this.closed) return
    this.closed = true
    this.queued = []
    this.chunks = []
    for (const listener of this.closeListeners) listener(error)
    this.closeListeners.clear()
    this.frameListeners.clear()
  }

  handleMessage(message: Uint8Array): void {
    if (this.closed) return
    let chunk: Uint8Array
    try {
      if (message.length > NOISE_MAX_MESSAGE) throw new NoiseError('message too large')
      chunk = this.receiver.decryptWithAd(new Uint8Array(0), message)
      if (chunk.length < 1 || chunk[0] > LAST) throw new NoiseError('malformed chunk')
    } catch (error) {
      this.close(error instanceof Error ? error : new SecureChannelError(String(error)))
      return
    }
    this.chunkBytes += chunk.length - 1
    if (this.chunkBytes > this.maxFrame) {
      this.close(new SecureChannelError('frame too large'))
      return
    }
    this.chunks.push(chunk.subarray(1))
    if (chunk[0] !== LAST) return
    const frame = this.chunks.length === 1 ? this.chunks[0] : concatBytes(...this.chunks)
    this.chunks = []
    this.chunkBytes = 0
    if (this.frameListeners.size === 0 || this.queued.length > 0) this.queued.push(frame)
    else for (const listener of [...this.frameListeners]) listener(frame)
  }
}
