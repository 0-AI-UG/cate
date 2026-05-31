import { describe, it, expect } from 'vitest'
import { formatTerminalPaste } from './terminalDrop'

describe('formatTerminalPaste', () => {
  it('pastes a plain path unquoted', () => {
    expect(formatTerminalPaste([{ path: '/repo/src/a.ts' }])).toBe('/repo/src/a.ts')
  })

  it('appends :line for a search-line drag', () => {
    expect(formatTerminalPaste([{ path: '/repo/src/a.ts', line: 42 }])).toBe('/repo/src/a.ts:42')
  })

  it('joins multiple refs with spaces', () => {
    expect(formatTerminalPaste([{ path: '/a.ts' }, { path: '/b.ts', line: 3 }])).toBe('/a.ts /b.ts:3')
  })

  it('shell-quotes paths with spaces or special characters', () => {
    expect(formatTerminalPaste([{ path: '/repo/my file.ts', line: 7 }])).toBe("'/repo/my file.ts:7'")
  })

  it("escapes embedded single quotes", () => {
    expect(formatTerminalPaste([{ path: "/repo/it's.ts" }])).toBe("'/repo/it'\\''s.ts'")
  })
})
