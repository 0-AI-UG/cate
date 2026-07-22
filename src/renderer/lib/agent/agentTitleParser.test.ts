import { describe, expect, it } from 'vitest'
import { extractAgentTitleSegment, shellTitleBasename } from './agentTitleParser'

describe('extractAgentTitleSegment', () => {
  it('returns the middle segment of a 4-segment claude/iTerm title', () => {
    const raw = 'georgschrojahr — ✱ Test schroejahr.de aufrufen — bun ‹ claude — 133×24'
    expect(extractAgentTitleSegment(raw)).toBe('✱ Test schroejahr.de aufrufen')
  })

  it('keeps the spinner glyph so the live indicator survives', () => {
    const raw = 'cwd — ↻ Thinking… — node ‹ claude — 80×24'
    expect(extractAgentTitleSegment(raw)).toBe('↻ Thinking…')
  })

  it('returns the raw title when there is no em-dash delimiter', () => {
    expect(extractAgentTitleSegment('claude')).toBe('claude')
  })

  it('drops the cwd prefix when only one em-dash is present', () => {
    expect(extractAgentTitleSegment('foo — bar')).toBe('bar')
  })

  it('trims leading and trailing whitespace', () => {
    expect(extractAgentTitleSegment('   hello — world — tail   ')).toBe('world')
  })

  it('falls back to raw when the middle segment is empty', () => {
    const raw = 'cwd —    — tail'
    expect(extractAgentTitleSegment(raw)).toBe(raw.trim())
  })

  it('returns empty for empty input', () => {
    expect(extractAgentTitleSegment('')).toBe('')
    expect(extractAgentTitleSegment('   ')).toBe('')
  })
})

describe('shellTitleBasename', () => {
  it('collapses a Windows cwd title to the folder name', () => {
    expect(shellTitleBasename('C:\\Users\\foo\\myproject')).toBe('myproject')
  })

  it('collapses a POSIX cwd title to the folder name', () => {
    expect(shellTitleBasename('/Users/foo/myproject')).toBe('myproject')
  })

  it('collapses a UNC path to the final segment', () => {
    expect(shellTitleBasename('\\\\server\\share\\proj')).toBe('proj')
  })

  it('leaves a non-path title unchanged', () => {
    expect(shellTitleBasename('✳ Claude Code')).toBe('✳ Claude Code')
  })

  it('leaves a relative title containing a slash unchanged', () => {
    expect(shellTitleBasename('bun ‹ src/index.ts')).toBe('bun ‹ src/index.ts')
  })

  it('returns empty input unchanged', () => {
    expect(shellTitleBasename('')).toBe('')
  })
})
