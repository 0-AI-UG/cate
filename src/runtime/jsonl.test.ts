import { describe, expect, test, vi } from 'vitest'
import { FrameDecoder, serializeFrame } from './jsonl'
import type { AnyFrame } from './protocol'

describe('jsonl framing', () => {
  test('serializeFrame emits exactly one newline-terminated line', () => {
    const line = serializeFrame({ t: 'req', id: 1, method: 'ping', params: [] })
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1).includes('\n')).toBe(false)
    expect(JSON.parse(line)).toEqual({ t: 'req', id: 1, method: 'ping', params: [] })
  })

  test('decodes frames split across arbitrary chunk boundaries', () => {
    const frames: AnyFrame[] = []
    const dec = new FrameDecoder((f) => frames.push(f))
    const whole = serializeFrame({ t: 'res', id: 7, ok: true, data: { a: 1 } })
    // Feed it one byte at a time.
    for (const ch of whole) dec.push(ch)
    expect(frames).toEqual([{ t: 'res', id: 7, ok: true, data: { a: 1 } }])
    expect(dec.pending).toBe(0)
  })

  test('decodes multiple frames delivered in a single chunk', () => {
    const frames: AnyFrame[] = []
    const dec = new FrameDecoder((f) => frames.push(f))
    dec.push(
      serializeFrame({ t: 'req', id: 1, method: 'a', params: [] }) +
        serializeFrame({ t: 'req', id: 2, method: 'b', params: [] }),
    )
    expect(frames.map((f) => (f as { id: number }).id)).toEqual([1, 2])
  })

  test('tolerates a trailing carriage return (WSL/Windows pipes)', () => {
    const frames: AnyFrame[] = []
    const dec = new FrameDecoder((f) => frames.push(f))
    dec.push(JSON.stringify({ t: 'req', id: 3, method: 'a', params: [] }) + '\r\n')
    expect((frames[0] as { id: number }).id).toBe(3)
  })

  test('skips blank lines and reports malformed JSON without throwing', () => {
    const frames: AnyFrame[] = []
    const onError = vi.fn()
    const dec = new FrameDecoder((f) => frames.push(f), onError)
    dec.push('\n')
    dec.push('not json\n')
    dec.push(serializeFrame({ t: 'req', id: 9, method: 'ok', params: [] }))
    expect(onError).toHaveBeenCalledTimes(1)
    expect((frames[0] as { id: number }).id).toBe(9)
  })
})
