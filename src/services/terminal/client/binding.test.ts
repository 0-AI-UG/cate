import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { describe, expect, it, vi } from 'vitest'
import type { AttachEvent } from '../contract'
import { bindTerminal, type ProcessProxy, type XtermLike } from './binding'

function transport() {
  let event!: (event: AttachEvent) => void
  let bytes!: (bytes: Uint8Array) => void
  const ack = vi.fn()
  const sub = {
    onEvent: (fn: typeof event) => { event = fn },
    onBytes: (fn: typeof bytes) => { bytes = fn },
    done: new Promise<never>(() => {}),
    ack, cancel: vi.fn(), write: vi.fn(),
  }
  const proc: ProcessProxy = {
    attach: () => sub as unknown as ReturnType<ProcessProxy['attach']>,
    view: async () => {}, fit: async () => {},
  }
  return { proc, ack, screen: (data: string) => event({ kind: 'screen', viewer: 'v1', data, cols: 80, rows: 24 }), live: (data: Uint8Array) => bytes(data) }
}

const flushed = (term: Terminal) => new Promise<void>(resolve => term.write('', resolve))

describe('terminal binding parser chunks', () => {
  it('preserves Unicode, attributes and modes across string and UTF-8 boundaries', async () => {
    const t = transport()
    const actual = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    const expected = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    const a = new SerializeAddon()
    const b = new SerializeAddon()
    actual.loadAddon(a as never)
    expected.loadAddon(b as never)
    const binding = bindTerminal({ terminal: actual, process: t.proc, id: 'p' })
    try {
      // High surrogate and a multi-byte UTF-8 sequence cross the 16 KiB boundary.
      const screen = 'a'.repeat(16383) + '🚀\x1b[31mred\x1b[0m\r\n' + 'b'.repeat(32765) + '\x1b[?2004h'
      const live = new TextEncoder().encode('c'.repeat(16383) + '界🚀\r\n\x1b[?1049hALT\x1b[?1049lEND')
      t.screen(screen)
      t.live(live)
      expected.write(screen)
      expected.write(live)
      await vi.waitFor(() => expect(t.ack).toHaveBeenCalledExactlyOnceWith(live.length))
      await Promise.all([flushed(actual), flushed(expected)])
      expect(a.serialize()).toBe(b.serialize())
      expect(t.ack).toHaveBeenCalledExactlyOnceWith(live.length)
    } finally { binding.dispose(); actual.dispose(); expected.dispose() }
  })

  it('acknowledges a byte event only after its last chunk is parsed', () => {
    const t = transport()
    const callbacks: Array<(() => void) | undefined> = []
    const writes: Array<string | Uint8Array> = []
    const terminal: XtermLike = {
      write: (data, cb) => { writes.push(data); callbacks.push(cb) },
      reset: () => {}, onData: () => ({ dispose() {} }),
    }
    const binding = bindTerminal({ terminal, process: t.proc, id: 'p' })
    try {
      t.live(new Uint8Array(40000))
      expect(writes.map(x => x.length)).toEqual([16384, 16384, 7232])
      expect(callbacks.slice(0, -1)).toEqual([undefined, undefined])
      expect(t.ack).not.toHaveBeenCalled()
      callbacks.at(-1)!()
      expect(t.ack).toHaveBeenCalledExactlyOnceWith(40000)
      t.live(new Uint8Array())
      callbacks.at(-1)!()
      expect(t.ack).toHaveBeenLastCalledWith(0)
    } finally { binding.dispose() }
  })
})
