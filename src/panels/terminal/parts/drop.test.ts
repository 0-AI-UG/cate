import { describe, it, expect } from 'vitest'
import { droppedRefs, formatTerminalPaste } from './drop'

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

describe('droppedRefs', () => {
  const data = (entries: Record<string, string>) => ({ getData: (format: string) => entries[format] ?? '' })

  it('reads every dragged file and the line of a search-line drag', () => {
    expect(droppedRefs(data({
      'application/cate-files': JSON.stringify(['/repo/a.ts', '/repo/b.ts']),
      'application/cate-file-line': JSON.stringify({ path: '/repo/a.ts', line: 4, column: 1 }),
    }))).toEqual([{ path: '/repo/a.ts', line: 4 }, { path: '/repo/b.ts' }])
    expect(droppedRefs(data({ 'application/cate-file': '/repo/c.ts' }))).toEqual([{ path: '/repo/c.ts' }])
    expect(droppedRefs(data({ 'application/cate-files': '{' }))).toEqual([])
  })
})
