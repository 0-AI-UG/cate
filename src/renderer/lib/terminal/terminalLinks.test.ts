import { describe, it, expect } from 'vitest'

import { resolveTerminalLinkTarget } from './terminalLinks'

function mods(
  m: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey', boolean>> = {},
): { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean } {
  return { metaKey: false, ctrlKey: false, shiftKey: false, ...m }
}

describe('resolveTerminalLinkTarget — macOS (primary = Cmd)', () => {
  it('Cmd+Click → internal browser panel', () => {
    expect(resolveTerminalLinkTarget(mods({ metaKey: true }), true)).toBe('panel')
  })

  it('Cmd+Shift+Click → external browser', () => {
    expect(resolveTerminalLinkTarget(mods({ metaKey: true, shiftKey: true }), true)).toBe('external')
  })

  it('plain click → ignore', () => {
    expect(resolveTerminalLinkTarget(mods(), true)).toBe('ignore')
  })

  it('Ctrl+Click on mac → ignore (Cmd is the modifier, not Ctrl)', () => {
    expect(resolveTerminalLinkTarget(mods({ ctrlKey: true }), true)).toBe('ignore')
  })
})

describe('resolveTerminalLinkTarget — Windows/Linux (primary = Ctrl)', () => {
  it('Ctrl+Click → internal browser panel', () => {
    expect(resolveTerminalLinkTarget(mods({ ctrlKey: true }), false)).toBe('panel')
  })

  it('Ctrl+Shift+Click → external browser', () => {
    expect(resolveTerminalLinkTarget(mods({ ctrlKey: true, shiftKey: true }), false)).toBe('external')
  })

  it('plain click → ignore', () => {
    expect(resolveTerminalLinkTarget(mods(), false)).toBe('ignore')
  })

  it('Cmd+Click on non-mac → ignore (Ctrl is the modifier, not Cmd)', () => {
    expect(resolveTerminalLinkTarget(mods({ metaKey: true }), false)).toBe('ignore')
  })
})
