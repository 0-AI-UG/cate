import { describe, it, expect } from 'vitest'

import { resolveTerminalKeySequence, MAC_TERMINAL_KEYMAP } from './terminalKeymap'

/** Build a minimal KeyboardEvent-shaped object. The resolver only reads
 *  key + the four modifier flags, so a plain literal is enough (no jsdom). */
function ev(
  key: string,
  mods: Partial<Record<'metaKey' | 'altKey' | 'ctrlKey' | 'shiftKey', boolean>> = {},
): KeyboardEvent {
  return {
    key,
    metaKey: false,
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
    ...mods,
  } as unknown as KeyboardEvent
}

describe('resolveTerminalKeySequence — macOS line-editing chords (VS Code parity)', () => {
  it('Cmd+Backspace → kill to line start (Ctrl+U)', () => {
    expect(resolveTerminalKeySequence(ev('Backspace', { metaKey: true }), true)).toBe('\x15')
  })

  it('Option+Backspace → delete word left (Ctrl+W)', () => {
    expect(resolveTerminalKeySequence(ev('Backspace', { altKey: true }), true)).toBe('\x17')
  })

  it('Option+Delete (forward) → delete word right (ESC d)', () => {
    expect(resolveTerminalKeySequence(ev('Delete', { altKey: true }), true)).toBe('\x1bd')
  })

  it('Cmd+ArrowLeft → move to line start (Ctrl+A)', () => {
    expect(resolveTerminalKeySequence(ev('ArrowLeft', { metaKey: true }), true)).toBe('\x01')
  })

  it('Cmd+ArrowRight → move to line end (Ctrl+E)', () => {
    expect(resolveTerminalKeySequence(ev('ArrowRight', { metaKey: true }), true)).toBe('\x05')
  })

  it('Option+ArrowLeft → word left (ESC b)', () => {
    expect(resolveTerminalKeySequence(ev('ArrowLeft', { altKey: true }), true)).toBe('\x1bb')
  })

  it('Option+ArrowRight → word right (ESC f)', () => {
    expect(resolveTerminalKeySequence(ev('ArrowRight', { altKey: true }), true)).toBe('\x1bf')
  })
})

describe('resolveTerminalKeySequence — non-matches return null', () => {
  it('returns null on non-mac (Win/Linux unchanged)', () => {
    expect(resolveTerminalKeySequence(ev('Backspace', { metaKey: true }), false)).toBeNull()
    expect(resolveTerminalKeySequence(ev('ArrowLeft', { altKey: true }), false)).toBeNull()
  })

  it('plain Backspace / arrows with no modifiers → null (xterm default)', () => {
    expect(resolveTerminalKeySequence(ev('Backspace'), true)).toBeNull()
    expect(resolveTerminalKeySequence(ev('ArrowLeft'), true)).toBeNull()
    expect(resolveTerminalKeySequence(ev('ArrowRight'), true)).toBeNull()
    expect(resolveTerminalKeySequence(ev('Delete'), true)).toBeNull()
  })

  it('does not hijack adjacent chords with extra modifiers', () => {
    // Cmd+Shift+Backspace stays free (e.g. for a future deleteNode rebind)
    expect(resolveTerminalKeySequence(ev('Backspace', { metaKey: true, shiftKey: true }), true)).toBeNull()
    // Cmd+Ctrl+Backspace
    expect(resolveTerminalKeySequence(ev('Backspace', { metaKey: true, ctrlKey: true }), true)).toBeNull()
    // Cmd+Option+ArrowLeft
    expect(resolveTerminalKeySequence(ev('ArrowLeft', { metaKey: true, altKey: true }), true)).toBeNull()
  })

  it('Cmd+Delete (forward) has no mapping — only Option+Delete does', () => {
    expect(resolveTerminalKeySequence(ev('Delete', { metaKey: true }), true)).toBeNull()
  })

  it('unrelated keys → null', () => {
    expect(resolveTerminalKeySequence(ev('a', { metaKey: true }), true)).toBeNull()
    expect(resolveTerminalKeySequence(ev('Enter', { metaKey: true }), true)).toBeNull()
    expect(resolveTerminalKeySequence(ev('ArrowUp', { altKey: true }), true)).toBeNull()
  })
})

describe('MAC_TERMINAL_KEYMAP table', () => {
  it('has the 7 VS Code-parity chords and every send sequence is non-empty', () => {
    expect(MAC_TERMINAL_KEYMAP).toHaveLength(7)
    for (const entry of MAC_TERMINAL_KEYMAP) {
      expect(entry.send.length).toBeGreaterThan(0)
      expect(entry.label.length).toBeGreaterThan(0)
    }
  })
})
