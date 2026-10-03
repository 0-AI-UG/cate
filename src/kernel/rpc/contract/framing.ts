// Frame codecs (architecture 7.8). A frame body is one type byte followed by
// either UTF-8 JSON (a message) or a u32 stream id and raw bytes (a chunk).
// WebSocket and WebRTC carry one body per message; the local socket prefixes
// each body with its u32 length. Big-endian throughout.

import { isMessage, type Frame } from './messages'

const TYPE_MSG = 0
const TYPE_BYTES = 1

/** Frames above this are a protocol violation; the transport should close. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export class FramingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FramingError'
  }
}

/** Encodes one frame as a message body (WebSocket, WebRTC). */
export function encodeFrame(frame: Frame): Uint8Array {
  if (frame.kind === 'msg') {
    const json = encoder.encode(JSON.stringify(frame.msg))
    const out = new Uint8Array(1 + json.length)
    out[0] = TYPE_MSG
    out.set(json, 1)
    return out
  }
  const out = new Uint8Array(5 + frame.bytes.length)
  out[0] = TYPE_BYTES
  new DataView(out.buffer).setUint32(1, frame.streamId >>> 0)
  out.set(frame.bytes, 5)
  return out
}

/** Decodes one message body. Throws FramingError on anything malformed. */
export function decodeFrame(body: Uint8Array): Frame {
  if (body.length === 0) throw new FramingError('Empty frame')
  if (body[0] === TYPE_MSG) {
    let value: unknown
    try {
      value = JSON.parse(decoder.decode(body.subarray(1)))
    } catch {
      throw new FramingError('Malformed JSON frame')
    }
    if (!isMessage(value)) throw new FramingError('Unknown message')
    return { kind: 'msg', msg: value }
  }
  if (body[0] === TYPE_BYTES) {
    if (body.length < 5) throw new FramingError('Truncated chunk frame')
    const streamId = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(1)
    return { kind: 'bytes', streamId, bytes: body.slice(5) }
  }
  throw new FramingError(`Unknown frame type ${body[0]}`)
}

/** Encodes one frame with its u32 length prefix (local socket). */
export function encodeLengthPrefixed(frame: Frame): Uint8Array {
  if (frame.kind === 'bytes') {
    // Output streams are mostly chunks: one allocation, one copy.
    const size = 5 + frame.bytes.length
    if (size > MAX_FRAME_BYTES) throw new FramingError('Frame too large')
    const out = new Uint8Array(4 + size)
    const view = new DataView(out.buffer)
    view.setUint32(0, size)
    out[4] = TYPE_BYTES
    view.setUint32(5, frame.streamId >>> 0)
    out.set(frame.bytes, 9)
    return out
  }
  const body = encodeFrame(frame)
  if (body.length > MAX_FRAME_BYTES) throw new FramingError('Frame too large')
  const out = new Uint8Array(4 + body.length)
  new DataView(out.buffer).setUint32(0, body.length)
  out.set(body, 4)
  return out
}

/** Incremental reader for length-prefixed frames. Feed it arbitrary chunks. */
export class LengthPrefixedReader {
  // Received chunks not yet consumed, the first one from `head` on. A frame
  // spanning chunks is assembled once, when all of it is here; a frame inside
  // one chunk is decoded from a view of it.
  private chunks: Uint8Array[] = []
  private head = 0
  private buffered = 0

  constructor(private readonly maxFrameBytes = MAX_FRAME_BYTES) {}

  /** Returns every frame completed by `chunk`. Throws FramingError; the
   *  stream is unusable afterwards. */
  push(chunk: Uint8Array): Frame[] {
    if (chunk.length > 0) {
      this.chunks.push(chunk)
      this.buffered += chunk.length
    }
    const frames: Frame[] = []
    while (this.buffered >= 4) {
      const header = this.peek(4)
      const len = new DataView(header.buffer, header.byteOffset, 4).getUint32(0)
      if (len > this.maxFrameBytes) throw new FramingError('Frame too large')
      if (this.buffered - 4 < len) break
      this.skip(4)
      frames.push(decodeFrame(this.take(len)))
    }
    return frames
  }

  /** Bytes buffered towards an incomplete frame. */
  get pending(): number {
    return this.buffered
  }

  /** The next `n` buffered bytes, without consuming them. */
  private peek(n: number): Uint8Array {
    const first = this.chunks[0]
    if (first.length - this.head >= n) return first.subarray(this.head, this.head + n)
    const out = new Uint8Array(n)
    let filled = 0
    let offset = this.head
    for (const chunk of this.chunks) {
      const part = chunk.subarray(offset, offset + (n - filled))
      out.set(part, filled)
      filled += part.length
      offset = 0
      if (filled === n) break
    }
    return out
  }

  private take(n: number): Uint8Array {
    const out = this.peek(n)
    this.skip(n)
    return out
  }

  private skip(n: number): void {
    this.buffered -= n
    while (n > 0) {
      const rest = this.chunks[0].length - this.head
      if (n < rest) {
        this.head += n
        return
      }
      n -= rest
      this.chunks.shift()
      this.head = 0
    }
  }
}
