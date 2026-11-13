import { describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import type { TerminalBinding } from '@services/terminal/client'
import { createTerminalHistory } from './history'

function setup(limit = 2000) {
  let scroll = () => {}
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const binding = { setScrollback: vi.fn((_limit: number, _beforeReset?: () => void) => new Promise<void>((yes, no) => { resolve = yes; reject = no })) }
  const b = { type: 'normal', baseY: 128, viewportY: 128, length: 152, getLine: (row: number) => ({ translateToString: () => `row-${row}` }) }
  const viewport = new EventTarget()
  const terminal = {
    element: { querySelector: () => viewport },
    buffer: { active: b }, options: { scrollback: 128 }, cols: 80,
    getSelectionPosition: vi.fn(() => undefined as {start:{x:number;y:number};end:{x:number;y:number}} | undefined),
    scrollToLine: vi.fn(), select: vi.fn(),
    getSelection: vi.fn(() => 'selected text'), clearSelection: vi.fn(),
    onScroll: (fn: () => void) => { scroll = fn; return { dispose: vi.fn() } },
  }
  const error = vi.fn()
  const history = createTerminalHistory(terminal as unknown as Terminal, binding as unknown as TerminalBinding, limit, error)
  return { history, terminal, binding, b, error, viewport, scroll: () => scroll(), resolve: () => resolve(), reject: () => reject(new Error('offline')) }
}

describe('on-demand terminal history', () => {
  it('leaves following output and TUIs on the tail, hydrates once when scrolling upward, preserves viewport and selection', async () => {
    const t = setup()
    t.scroll()
    t.b.type = 'alternate'; t.b.viewportY = 0; t.scroll()
    expect(t.binding.setScrollback).not.toHaveBeenCalled()
    t.b.type = 'normal'; t.b.viewportY = 100
    t.terminal.getSelectionPosition.mockReturnValue({start:{x:2,y:110},end:{x:5,y:111}})
    t.scroll()
    const loaded = t.history.load()
    expect(t.binding.setScrollback).toHaveBeenCalledExactlyOnceWith(2000, expect.any(Function))
    expect(t.terminal.options.scrollback).toBe(2000)
    t.binding.setScrollback.mock.calls[0][1]!()
    t.b.length = 2024; t.b.baseY = 2000
    t.b.getLine = (row: number) => ({ translateToString: () => `row-${row - 1872}` })
    t.resolve(); await loaded
    expect(t.terminal.scrollToLine).toHaveBeenCalledWith(1972)
    expect(t.terminal.select).toHaveBeenCalledWith(2, 1982, 83)
    expect(t.terminal.clearSelection).not.toHaveBeenCalled()
    await t.history.load()
    expect(t.binding.setScrollback).toHaveBeenCalledOnce()
    t.history.dispose()
  })

  it('anchors the latest gesture and selection to their text when output advances during hydration', async () => {
    const t = setup()
    const loaded = t.history.load()
    // The person scrolls/selects further while a remote snapshot is in flight.
    t.b.viewportY = 80
    t.terminal.getSelectionPosition.mockReturnValue({start:{x:1,y:90},end:{x:5,y:91}})
    t.binding.setScrollback.mock.calls[0][1]!()
    t.b.length = 2024; t.b.baseY = 2000
    // Ten unseen output rows displace the old tail within the full snapshot.
    t.b.getLine = (row: number) => ({ translateToString: () => `row-${row - 1862}` })
    t.resolve(); await loaded
    expect(t.terminal.scrollToLine).toHaveBeenCalledWith(1942)
    expect(t.terminal.select).toHaveBeenCalledWith(1, 1952, 84)
    t.history.dispose()
  })

  it('clears a repeated-start-line multi-line selection when unseen output makes the nearest anchor cover different text', async () => {
    const t = setup()
    let range = { x: 0, y: 90, length: 163 }
    const oldRows = new Map([[90, 'REPEATED HEADER'], [91, 'original payload 界🚀'], [92, 'END']])
    t.b.getLine = (row) => ({ translateToString: () => oldRows.get(row) ?? `row-${row}` })
    t.terminal.getSelectionPosition.mockReturnValue({start:{x:0,y:90},end:{x:3,y:92}})
    // Read the entire selected range from the current buffer, as xterm does.
    t.terminal.getSelection.mockImplementation(() => {
      if (range.length === 0) return ''
      const endY = range.y + Math.floor((range.x + range.length) / 80)
      const endX = (range.x + range.length) % 80
      return Array.from({length: endY - range.y + 1}, (_, i) => {
        const row = range.y + i
        const text = t.b.getLine(row).translateToString()
        return text.slice(i === 0 ? range.x : 0, row === endY ? endX : undefined)
      }).join('\n')
    })
    t.terminal.select.mockImplementation((x: number, y: number, length: number) => { range = { x, y, length } })
    t.terminal.clearSelection.mockImplementation(() => { range = { x: 0, y: 0, length: 0 } })
    const loaded = t.history.load()
    t.binding.setScrollback.mock.calls[0][1]!()
    t.b.length = 2024; t.b.baseY = 2000
    const newRows = new Map([
      // The original block shifted by ten unseen output rows.
      [1952, 'REPEATED HEADER'], [1953, 'original payload 界🚀'], [1954, 'END'],
      // The length-based expected location has the same first line only.
      [1962, 'REPEATED HEADER'], [1963, 'different payload'], [1964, 'END'],
    ])
    t.b.getLine = (row) => ({ translateToString: () => newRows.get(row) ?? `new-${row}` })
    t.resolve(); await loaded
    expect(t.terminal.select).toHaveBeenCalledWith(0, 1962, 163)
    expect(t.terminal.getSelection.mock.results.map(result => result.value)).toContain('REPEATED HEADER\ndifferent payload\nEND')
    expect(t.terminal.clearSelection).toHaveBeenCalledOnce()
    expect(t.terminal.getSelection()).toBe('')
    t.history.dispose()
  })

  it('hydrates native viewport scrolls even when xterm suppresses its public event, and removes the listener on disposal', async () => {
    const t = setup()
    t.b.viewportY = 90
    t.viewport.dispatchEvent(new Event('scroll'))
    const loaded = t.history.load()
    expect(t.binding.setScrollback).toHaveBeenCalledOnce()
    t.resolve(); await loaded
    t.history.dispose()
    const disposed = setup()
    disposed.history.dispose()
    disposed.b.viewportY = 90
    disposed.viewport.dispatchEvent(new Event('scroll'))
    expect(disposed.binding.setScrollback).not.toHaveBeenCalled()
  })

  it('awaits search hydration, retries failures and ignores completion after disposal', async () => {
    const t = setup()
    const first = t.history.load()
    t.reject(); await expect(first).rejects.toThrow('offline')
    const second = t.history.load()
    t.history.dispose(); t.resolve(); await second
    expect(t.terminal.scrollToLine).not.toHaveBeenCalled()
    expect(t.binding.setScrollback).toHaveBeenCalledTimes(2)
  })

  it('keeps small configured histories without a replacement', async () => {
    const t = setup(100)
    await t.history.load()
    expect(t.binding.setScrollback).not.toHaveBeenCalled()
    t.history.dispose()
  })
})
