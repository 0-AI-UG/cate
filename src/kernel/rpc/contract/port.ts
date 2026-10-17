// The frame port: the one thing the rpc server and client need from a
// transport. Transports adapt their socket, WebSocket or data channel to it.

import {
  decodeFrame,
  encodeFrame,
  encodeLengthPrefixed,
  LengthPrefixedReader,
} from './framing'
import type { Frame } from './messages'

export interface FramePort {
  send(frame: Frame): void
  /** One listener; setting it again replaces it. */
  onFrame(listener: (frame: Frame) => void): void
  /** One listener; called once when either side closes. */
  onClose(listener: (reason?: string) => void): void
  close(reason?: string): void
}

/** A raw byte pipe: a socket (a stream of chunks) or a message channel (one
 *  frame per message). */
export interface ByteDuplex {
  write(bytes: Uint8Array): void
  onData(listener: (bytes: Uint8Array) => void): void
  onClose(listener: (reason?: string) => void): void
  close(reason?: string): void
}

/**
 * Wraps a byte pipe as a frame port. `stream` pipes (sockets) get length
 * prefixes; `message` pipes (WebSocket, WebRTC) carry one frame per message.
 * A malformed frame closes the port.
 */
export function framePortOver(duplex: ByteDuplex, mode: 'stream' | 'message'): FramePort {
  let frameListener: (frame: Frame) => void = () => {}
  let closeListener: (reason?: string) => void = () => {}
  let closed = false
  const reader = mode === 'stream' ? new LengthPrefixedReader() : null

  const finish = (reason?: string) => {
    if (closed) return
    closed = true
    closeListener(reason)
  }

  duplex.onData((bytes) => {
    if (closed) return
    let frames: Frame[]
    try {
      frames = reader ? reader.push(bytes) : [decodeFrame(bytes)]
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      duplex.close(reason)
      finish(reason)
      return
    }
    for (const frame of frames) frameListener(frame)
  })
  duplex.onClose(finish)

  return {
    send(frame) {
      if (closed) return
      duplex.write(mode === 'stream' ? encodeLengthPrefixed(frame) : encodeFrame(frame))
    },
    onFrame(listener) { frameListener = listener },
    onClose(listener) { closeListener = listener },
    close(reason) {
      if (closed) return
      duplex.close(reason)
      finish(reason)
    },
  }
}

/**
 * Two connected in-memory ports. Delivery is asynchronous and every frame goes
 * through the message codec, so tests see what a real transport would carry.
 */
export function createMemoryPortPair(): [FramePort, FramePort] {
  interface End {
    frame: (frame: Frame) => void
    close: (reason?: string) => void
  }
  const ends: [End, End] = [
    { frame: () => {}, close: () => {} },
    { frame: () => {}, close: () => {} },
  ]
  // `closed` stops new sends; frames already sent still arrive, then the close.
  let closed = false
  let finished = false
  const make = (self: 0 | 1): FramePort => {
    const peer = ends[self === 0 ? 1 : 0]
    return {
      send(frame) {
        if (closed) return
        const body = encodeFrame(frame)
        queueMicrotask(() => { if (!finished) peer.frame(decodeFrame(body)) })
      },
      onFrame(listener) { ends[self].frame = listener },
      onClose(listener) { ends[self].close = listener },
      close(reason) {
        if (closed) return
        closed = true
        queueMicrotask(() => {
          finished = true
          ends[0].close(reason)
          ends[1].close(reason)
        })
      },
    }
  }
  return [make(0), make(1)]
}
