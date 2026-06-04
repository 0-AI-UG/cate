import { describe, it, expect } from 'vitest'
import { resolveTerminalKeySequence, MAC_TERMINAL_KEYMAP, type TerminalKeyEvent } from './terminalKeymap'

function ev(partial: Partial<TerminalKeyEvent> & { key: string }): TerminalKeyEvent {
  return { metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, ...partial }
}

describe('resolveTerminalKeySequence (macOS line-editing chords)', () => {
  const cases: Array<[string, TerminalKeyEvent, string]> = [
    ['Cmd+Backspace → Ctrl+U', ev({ key: 'Backspace', metaKey: true }), '\x15'],
    ['Option+Backspace → Ctrl+W', ev({ key: 'Backspace', altKey: true }), '\x17'],
    ['Option+Delete → ESC d', ev({ key: 'Delete', altKey: true }), '\x1bd'],
    ['Cmd+Left → Ctrl+A', ev({ key: 'ArrowLeft', metaKey: true }), '\x01'],
    ['Cmd+Right → Ctrl+E', ev({ key: 'ArrowRight', metaKey: true }), '\x05'],
    ['Option+Left → ESC b', ev({ key: 'ArrowLeft', altKey: true }), '\x1bb'],
    ['Option+Right → ESC f', ev({ key: 'ArrowRight', altKey: true }), '\x1bf'],
  ]

  for (const [name, event, expected] of cases) {
    it(name, () => {
      expect(resolveTerminalKeySequence(event, true)).toBe(expected)
    })
  }

  it('returns null on non-macOS for every chord', () => {
    for (const [, event] of cases) {
      expect(resolveTerminalKeySequence(event, false)).toBeNull()
    }
  })

  it('ignores plain keys (no Cmd/Option modifier)', () => {
    expect(resolveTerminalKeySequence(ev({ key: 'Backspace' }), true)).toBeNull()
    expect(resolveTerminalKeySequence(ev({ key: 'ArrowLeft' }), true)).toBeNull()
  })

  it('does not fire when Ctrl or Shift is also held', () => {
    expect(resolveTerminalKeySequence(ev({ key: 'Backspace', metaKey: true, ctrlKey: true }), true)).toBeNull()
    expect(resolveTerminalKeySequence(ev({ key: 'Backspace', metaKey: true, shiftKey: true }), true)).toBeNull()
  })

  it('does not fire when both Cmd and Option are held (ambiguous)', () => {
    expect(resolveTerminalKeySequence(ev({ key: 'Backspace', metaKey: true, altKey: true }), true)).toBeNull()
  })

  it('leaves forward Delete with Cmd alone (only Option+Delete is mapped)', () => {
    expect(resolveTerminalKeySequence(ev({ key: 'Delete', metaKey: true }), true)).toBeNull()
  })
})

describe('MAC_TERMINAL_KEYMAP table', () => {
  it('has the 7 VS Code-parity chords, each with a non-empty send + label', () => {
    expect(MAC_TERMINAL_KEYMAP).toHaveLength(7)
    for (const entry of MAC_TERMINAL_KEYMAP) {
      expect(entry.send.length).toBeGreaterThan(0)
      expect(entry.label.length).toBeGreaterThan(0)
    }
  })
})
