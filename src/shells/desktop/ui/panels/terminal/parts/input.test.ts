// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { isTerminalPasteChord, makeTerminalKeyEventHandler } from './input'

const key = (init: Partial<KeyboardEvent> & { key: string }) =>
  ({ type: 'keydown', metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, preventDefault: vi.fn(), ...init }) as unknown as KeyboardEvent

describe('key handler', () => {
  const selection = { hasSelection: () => false }

  it('sends macOS line-editing chords as bytes', () => {
    const send = vi.fn()
    const event = key({ key: 'Backspace', metaKey: true })
    expect(makeTerminalKeyEventHandler(selection, send, true)(event)).toBe(false)
    expect(send).toHaveBeenCalledWith('\x15')
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('encodes modified special keys as CSI u but leaves app shortcuts alone', () => {
    const send = vi.fn()
    const handler = makeTerminalKeyEventHandler(selection, send, true)
    expect(handler(key({ key: 'Enter', shiftKey: true }))).toBe(false)
    expect(send).toHaveBeenCalledWith('\x1b[13;2u')
    expect(handler(key({ key: 'Tab', shiftKey: true }))).toBe(true)
    expect(handler(key({ key: 'Enter', metaKey: true, shiftKey: true }))).toBe(true)
    expect(handler(key({ key: 'a' }))).toBe(true)
  })

  it('lets the browser paste on Ctrl+V off Mac keyboards only', () => {
    expect(isTerminalPasteChord(key({ key: 'v', ctrlKey: true }), false)).toBe(true)
    expect(isTerminalPasteChord(key({ key: 'v', ctrlKey: true }), true)).toBe(false)
  })
})
