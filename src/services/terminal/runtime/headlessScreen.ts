// The screen of one PTY, kept by a headless xterm. xterm parses writes
// asynchronously, a whole chunk at a time, and calls a chunk's callback right
// after parsing it. So at any moment the serialized screen covers exactly the
// chunks whose callbacks ran, and `pending` holds the rest in order: a viewer
// that gets `serialize()` then `pending` then every later chunk sees each byte
// once.

import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import type { ReadResult } from '../contract'

interface ScreenCapture {
  /** The serialized screen: text, styles, modes and the alternate buffer. */
  screen: string
  /** Output written after the screen, not yet parsed. */
  pending: string[]
  cols: number
  rows: number
}

export class HeadlessScreen {
  private readonly term: Terminal
  private readonly serializer = new SerializeAddon()
  private readonly queue: string[] = []
  private queuedChars = 0
  private readonly drainWaiters: Array<() => void> = []
  private disposed = false

  constructor(cols: number, rows: number, scrollback: number) {
    this.term = new Terminal({ cols, rows, scrollback, allowProposedApi: true })
    this.term.loadAddon(this.serializer as never)
  }

  get cols(): number { return this.term.cols }
  get rows(): number { return this.term.rows }
  /** Characters written but not yet parsed. */
  get backlog(): number { return this.queuedChars }

  write(data: string): void {
    if (this.disposed || data.length === 0) return
    this.queue.push(data)
    this.queuedChars += data.length
    this.term.write(data, () => {
      const done = this.queue.shift()
      this.queuedChars -= done?.length ?? 0
      if (this.queue.length === 0) for (const resolve of this.drainWaiters.splice(0)) resolve()
    })
  }

  /** Resolves once everything written so far is parsed. */
  settled(): Promise<void> {
    if (this.disposed || this.queue.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.drainWaiters.push(resolve))
  }

  /** The screen with at most `scrollback` lines above it (all by default). */
  capture(scrollback?: number): ScreenCapture {
    return {
      screen: this.disposed ? '' : this.serializer.serialize(scrollback === undefined ? undefined : { scrollback }),
      pending: [...this.queue],
      cols: this.term.cols,
      rows: this.term.rows,
    }
  }

  resize(cols: number, rows: number): void {
    if (this.disposed || (cols === this.term.cols && rows === this.term.rows)) return
    this.term.resize(cols, rows)
  }

  setScrollback(lines: number): void {
    if (!this.disposed) this.term.options.scrollback = lines
  }

  /** Text of the active buffer, without trailing empty rows; a row the
   *  terminal soft-wrapped joins the line it continues, so output reads as
   *  written. Call after `settled()` to include everything written. */
  read(lines?: number): ReadResult {
    const buffer = this.term.buffer.active
    const out: string[] = []
    for (let index = 0; index < buffer.length; index++) {
      const line = buffer.getLine(index)
      // A row that wraps on keeps its trailing blanks: they are content.
      const text = line?.translateToString(!buffer.getLine(index + 1)?.isWrapped) ?? ''
      if (line?.isWrapped && out.length > 0) out[out.length - 1] += text
      else out.push(text)
    }
    while (out.length > 0 && out[out.length - 1] === '') out.pop()
    const text = lines !== undefined && lines >= 0 ? out.slice(Math.max(0, out.length - lines)) : out
    return { alt: buffer.type === 'alternate', text: text.join('\n') }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const resolve of this.drainWaiters.splice(0)) resolve()
    this.term.dispose()
  }
}
