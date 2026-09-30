import { describe, expect, it } from 'vitest'
import {
  FramingError,
  LengthPrefixedReader,
  decodeFrame,
  encodeFrame,
  encodeLengthPrefixed,
} from './framing'
import { framePortOver, type ByteDuplex } from './port'
import type { Frame } from './messages'

const frames: Frame[] = [
  { kind: 'msg', msg: { t: 'hello', protocol: [1, 0], version: '2.0.0', client: { clientId: 'c1', device: { name: 'mac', keyFingerprint: 'ab' }, features: ['webview'] } } },
  { kind: 'msg', msg: { t: 'req', id: 7, cap: 'file', method: 'read', params: { path: '/tmp/ü' }, opId: 'c1:3' } },
  { kind: 'msg', msg: { t: 'res', id: 7, error: { code: 'gone', message: 'gone' } } },
  { kind: 'msg', msg: { t: 'ack', stream: 9, bytes: 4096 } },
  { kind: 'bytes', streamId: 0xfffffffe, bytes: new Uint8Array([0, 1, 2, 255]) },
  { kind: 'bytes', streamId: 3, bytes: new Uint8Array(0) },
]

describe('frame codec', () => {
  it('round-trips messages and chunks one frame per message', () => {
    for (const frame of frames) expect(decodeFrame(encodeFrame(frame))).toEqual(frame)
  })

  it('round-trips length-prefixed frames split at every byte', () => {
    const wire = concatAll(frames.map(encodeLengthPrefixed))
    const reader = new LengthPrefixedReader()
    const out: Frame[] = []
    for (let i = 0; i < wire.length; i++) out.push(...reader.push(wire.subarray(i, i + 1)))
    expect(out).toEqual(frames)
    expect(reader.pending).toBe(0)
  })

  it('assembles a large frame split across many chunks', () => {
    const big: Frame = { kind: 'bytes', streamId: 3, bytes: new Uint8Array(300_000).map((_, i) => i % 251) }
    const wire = concatAll([...[big, ...frames].map(encodeLengthPrefixed)])
    const reader = new LengthPrefixedReader()
    const out: Frame[] = []
    for (let i = 0; i < wire.length; i += 65_536) out.push(...reader.push(wire.subarray(i, i + 65_536)))
    expect(out).toEqual([big, ...frames])
    expect(reader.pending).toBe(0)
  })

  it('decodes several frames from one chunk', () => {
    const reader = new LengthPrefixedReader()
    expect(reader.push(concatAll(frames.map(encodeLengthPrefixed)))).toEqual(frames)
  })

  it('rejects malformed and oversized frames', () => {
    expect(() => decodeFrame(new Uint8Array([]))).toThrow(FramingError)
    expect(() => decodeFrame(new Uint8Array([9]))).toThrow(FramingError)
    expect(() => decodeFrame(new Uint8Array([0, 123]))).toThrow(FramingError)
    expect(() => decodeFrame(new Uint8Array([0, ...new TextEncoder().encode('{"t":"nope"}')]))).toThrow(FramingError)
    expect(() => new LengthPrefixedReader(10).push(new Uint8Array([0, 0, 0, 11]))).toThrow(FramingError)
  })

  it('closes a stream port on a malformed frame', () => {
    let onData: (b: Uint8Array) => void = () => {}
    let closedWith: string | undefined
    const duplex: ByteDuplex = {
      write: () => {},
      onData: (l) => { onData = l },
      onClose: () => {},
      close: (reason) => { closedWith = reason },
    }
    const port = framePortOver(duplex, 'stream')
    const received: Frame[] = []
    let portClosed = false
    port.onFrame((f) => received.push(f))
    port.onClose(() => { portClosed = true })
    onData(encodeLengthPrefixed(frames[1]))
    onData(new Uint8Array([0, 0, 0, 1, 7]))
    expect(received).toEqual([frames[1]])
    expect(portClosed).toBe(true)
    expect(closedWith).toMatch(/Unknown frame type/)
  })
})

function concatAll(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) { out.set(p, offset); offset += p.length }
  return out
}
