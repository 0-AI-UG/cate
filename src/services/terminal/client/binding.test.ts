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

function reattachingTransport() {
  const entries: Array<{
    event: (e: AttachEvent) => void
    bytes: (b: Uint8Array) => void
    cancel: ReturnType<typeof vi.fn>
    fail: (error: unknown) => void
  }> = []
  const attach = vi.fn(() => {
    const entry = { event: (_e: AttachEvent) => {}, bytes: (_b: Uint8Array) => {}, cancel: vi.fn(), fail: (_e: unknown) => {} }
    entries.push(entry)
    return {
      onEvent: (fn: typeof entry.event) => { entry.event = fn },
      onBytes: (fn: typeof entry.bytes) => { entry.bytes = fn },
      done: new Promise((_yes, no) => { entry.fail = no }),
      cancel: entry.cancel, ack: vi.fn(), write: vi.fn(),
    } as unknown as ReturnType<ProcessProxy['attach']>
  })
  const proc: ProcessProxy = { attach, fit: async () => {}, view: async () => {} }
  const screen = (i: number, data: string) => entries[i].event({ kind: 'screen', viewer: `v${i}`, data, cols: 80, rows: 24 })
  return { proc, attach, entries, screen }
}

describe('terminal history replacement lifecycle', () => {
  it('drains old parser writes, ignores canceled events, and puts new live bytes after the authoritative Unicode/TUI screen', async () => {
    const t = reattachingTransport()
    const term = new Terminal({ cols: 80, rows: 24, scrollback: 128, allowProposedApi: true })
    const expected = new Terminal({ cols: 80, rows: 24, scrollback: 2000, allowProposedApi: true })
    const a = new SerializeAddon(); const b = new SerializeAddon()
    term.loadAddon(a as never); expected.loadAddon(b as never)
    const binding = bindTerminal({ terminal: term, process: t.proc, id: 'p', scrollback: 128 })
    try {
      t.screen(0, 'tail\r\n')
      await flushed(term); await flushed(term)
      t.entries[0].bytes(new TextEncoder().encode('OLD'.repeat(20000)))
      term.options.scrollback = 2000
      const beforeReset = vi.fn(() => {
        expect(Array.from({ length: term.buffer.active.length }, (_, i) => term.buffer.active.getLine(i)?.translateToString(true)).join('')).toContain('OLD')
      })
      const ready = binding.setScrollback(2000, beforeReset)
      expect(binding.setScrollback(2000)).toBe(ready)
      expect(t.entries[0].cancel).toHaveBeenCalledOnce()
      t.entries[0].bytes(new TextEncoder().encode('STALE'))
      t.screen(0, 'STALE SCREEN')
      const full = Array.from({length: 500}, (_, i) => `\x1b[32m${i} 界🚀 é\x1b[0m\r\n`).join('') + '\x1b[?1049h\x1b[?1000hTUI'
      t.screen(1, full)
      t.entries[1].bytes(new TextEncoder().encode('\x1b[?1049lLIVE\r\n'))
      expected.write(full + '\x1b[?1049lLIVE\r\n')
      await ready
      expect(beforeReset).toHaveBeenCalledOnce()
      await Promise.all([flushed(term), flushed(expected)])
      expect(a.serialize()).toBe(b.serialize())
      expect(t.attach).toHaveBeenLastCalledWith({ id: 'p', visible: true, scrollback: 2000 }, { manualAck: true, resume: true })
      // A resumed stream sends another fresh snapshot on the same subscription.
      t.screen(1, full)
      await flushed(term); await flushed(term)
      expect(term.buffer.active.type).toBe('alternate')
    } finally { binding.dispose(); term.dispose(); expected.dispose() }
  })

  it('rejects hydration on transport failure or disposal, with no stale reset', async () => {
    const t = reattachingTransport()
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    const binding = bindTerminal({ terminal: term, process: t.proc, id: 'p', scrollback: 128 })
    const failed = binding.setScrollback(2000)
    t.entries[1].fail(new Error('offline'))
    await expect(failed).rejects.toThrow('offline')
    const disposed = binding.setScrollback(2000)
    t.screen(2, 'must not appear')
    binding.dispose()
    await expect(disposed).rejects.toThrow('disposed')
    await flushed(term)
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('')
    term.dispose()
  })
})
