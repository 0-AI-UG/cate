// =============================================================================
// FrameDecoder tests — see native/nativehost/PROTOCOL.md for the wire format:
//   [UInt32 BE payloadLength][UInt8 type][payload: payloadLength bytes]
// type 0x01 = JSON control message, 0x02 = raw JPEG frame.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { FrameDecoder } from './frameProtocol'

/** Build one framed message the way cate-nativehost writes it on the wire. */
function encode(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(5)
  header.writeUInt32BE(payload.length, 0)
  header.writeUInt8(type, 4)
  return Buffer.concat([header, payload])
}

function encodeJson(obj: unknown): Buffer {
  return encode(0x01, Buffer.from(JSON.stringify(obj), 'utf8'))
}

describe('FrameDecoder', () => {
  it('decodes one whole message delivered in a single push', () => {
    const decoder = new FrameDecoder()
    const msg = encodeJson({ t: 'ready', displayId: 1, appPid: 123 })
    const out = decoder.push(msg)
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe(0x01)
    expect(JSON.parse(out[0].payload.toString('utf8'))).toEqual({ t: 'ready', displayId: 1, appPid: 123 })
  })

  it('decodes a message split across two chunks', () => {
    const decoder = new FrameDecoder()
    const msg = encodeJson({ t: 'placed', onDisplay: true })
    const splitAt = 6 // inside the header/payload boundary somewhere
    const first = msg.subarray(0, splitAt)
    const second = msg.subarray(splitAt)

    const out1 = decoder.push(first)
    expect(out1).toHaveLength(0)

    const out2 = decoder.push(second)
    expect(out2).toHaveLength(1)
    expect(JSON.parse(out2[0].payload.toString('utf8'))).toEqual({ t: 'placed', onDisplay: true })
  })

  it('decodes two messages delivered in a single chunk', () => {
    const decoder = new FrameDecoder()
    const msgA = encodeJson({ t: 'status', frames: 1, complete: 1, idle: 0, suspended: 0 })
    const msgB = encodeJson({ t: 'status', frames: 2, complete: 2, idle: 0, suspended: 0 })
    const out = decoder.push(Buffer.concat([msgA, msgB]))
    expect(out).toHaveLength(2)
    expect(JSON.parse(out[0].payload.toString('utf8'))).toMatchObject({ frames: 1 })
    expect(JSON.parse(out[1].payload.toString('utf8'))).toMatchObject({ frames: 2 })
  })

  it('decodes an interleaved JSON control message and a JPEG frame', () => {
    const decoder = new FrameDecoder()
    const control = encodeJson({ t: 'ready', displayId: 2, appPid: 456 })
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0x02, 0x03])
    const frame = encode(0x02, jpegBytes)

    const out = decoder.push(Buffer.concat([control, frame]))
    expect(out).toHaveLength(2)
    expect(out[0].type).toBe(0x01)
    expect(out[1].type).toBe(0x02)
    expect(out[1].payload.equals(jpegBytes)).toBe(true)
  })

  it('decodes a large (>64KB) frame delivered across many small chunks', () => {
    const decoder = new FrameDecoder()
    const size = 200_000
    const jpegBytes = Buffer.alloc(size)
    for (let i = 0; i < size; i++) jpegBytes[i] = i % 256
    const frame = encode(0x02, jpegBytes)

    const chunkSize = 4096
    const collected: Array<{ type: number; payload: Buffer }> = []
    for (let offset = 0; offset < frame.length; offset += chunkSize) {
      const chunk = frame.subarray(offset, Math.min(offset + chunkSize, frame.length))
      collected.push(...decoder.push(chunk))
    }

    expect(collected).toHaveLength(1)
    expect(collected[0].type).toBe(0x02)
    expect(collected[0].payload.length).toBe(size)
    expect(collected[0].payload.equals(jpegBytes)).toBe(true)
  })

  it('handles a message trailing a whole one in the same chunk, then completed in a later chunk', () => {
    const decoder = new FrameDecoder()
    const msgA = encodeJson({ t: 'error', message: 'boom' })
    const msgB = encodeJson({ t: 'status', frames: 9, complete: 9, idle: 0, suspended: 0 })
    const firstChunk = Buffer.concat([msgA, msgB.subarray(0, 4)])
    const secondChunk = msgB.subarray(4)

    const out1 = decoder.push(firstChunk)
    expect(out1).toHaveLength(1)
    expect(JSON.parse(out1[0].payload.toString('utf8'))).toMatchObject({ t: 'error' })

    const out2 = decoder.push(secondChunk)
    expect(out2).toHaveLength(1)
    expect(JSON.parse(out2[0].payload.toString('utf8'))).toMatchObject({ t: 'status', frames: 9 })
  })

  it('returns an empty array when fed zero bytes', () => {
    const decoder = new FrameDecoder()
    expect(decoder.push(Buffer.alloc(0))).toHaveLength(0)
  })

  it('ignores unknown message types but keeps parsing subsequent messages', () => {
    const decoder = new FrameDecoder()
    const unknown = encode(0x99, Buffer.from('whatever'))
    const known = encodeJson({ t: 'ready', displayId: 3, appPid: 789 })
    const out = decoder.push(Buffer.concat([unknown, known]))
    expect(out).toHaveLength(2)
    expect(out[0].type).toBe(0x99)
    expect(out[1].type).toBe(0x01)
  })
})
