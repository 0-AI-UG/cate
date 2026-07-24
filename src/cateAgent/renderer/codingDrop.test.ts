import { describe, it, expect } from 'vitest'
import { buildFileMentions } from './codingDrop'

describe('buildFileMentions', () => {
  it('builds @path mentions for plain file drags', () => {
    expect(buildFileMentions(['/a.ts', '/b.ts'], null)).toBe('@/a.ts @/b.ts')
  })

  it('appends :line for the matching search-line drag', () => {
    expect(buildFileMentions(['/a.ts'], { path: '/a.ts', line: 42 })).toBe('@/a.ts:42')
  })

  it('only annotates the path that matches the line ref', () => {
    expect(buildFileMentions(['/a.ts', '/b.ts'], { path: '/b.ts', line: 7 })).toBe('@/a.ts @/b.ts:7')
  })

  it('ignores a line ref with no line number', () => {
    expect(buildFileMentions(['/a.ts'], { path: '/a.ts' })).toBe('@/a.ts')
  })
})
