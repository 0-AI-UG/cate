import { describe, expect, it } from 'vitest'
import { extractAgentTitleSegment } from './agentTitleParser'

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
