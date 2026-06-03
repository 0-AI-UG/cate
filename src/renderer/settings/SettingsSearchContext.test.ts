// =============================================================================
// Unit tests for matchesQuery — the substring matcher behind settings search.
// Callers pass an already-lowercased query; the matcher lowercases the text
// side and treats an empty query as "matches everything".
// =============================================================================

import { describe, expect, it } from 'vitest'
import { matchesQuery } from './SettingsSearchContext'

describe('matchesQuery', () => {
  it('an empty query matches everything', () => {
    expect(matchesQuery('Editor font size', '')).toBe(true)
    expect(matchesQuery('', '')).toBe(true)
    expect(matchesQuery(undefined, '')).toBe(true)
  })

  it('matches a substring of the text', () => {
    expect(matchesQuery('Editor font size', 'font')).toBe(true)
    expect(matchesQuery('Terminal font family', 'family')).toBe(true)
  })

  it('is case-insensitive on the text side', () => {
    expect(matchesQuery('Editor FONT Size', 'font')).toBe(true)
    expect(matchesQuery('SAVE FILE', 'save')).toBe(true)
  })

  it('returns false when the text does not contain the query', () => {
    expect(matchesQuery('Save File', 'terminal')).toBe(false)
    expect(matchesQuery('Zoom to Fit', 'redo')).toBe(false)
  })

  it('treats missing text as a non-match for a non-empty query', () => {
    expect(matchesQuery(undefined, 'font')).toBe(false)
    expect(matchesQuery('', 'font')).toBe(false)
  })
})
