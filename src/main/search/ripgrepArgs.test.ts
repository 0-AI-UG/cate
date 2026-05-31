import { describe, it, expect } from 'vitest'
import { buildRipgrepArgs } from './ripgrepArgs'
import type { SearchOptions } from '../../shared/types'

const base = (over: Partial<SearchOptions> = {}): SearchOptions => ({ query: 'foo', ...over })

/** Index of the value passed after a given flag. */
function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

describe('buildRipgrepArgs', () => {
  it('always emits --json and --line-number', () => {
    const args = buildRipgrepArgs(base(), '/root')
    expect(args).toContain('--json')
    expect(args).toContain('--line-number')
  })

  it('is case-insensitive by default, case-sensitive when matchCase', () => {
    expect(buildRipgrepArgs(base(), '/root')).toContain('--ignore-case')
    const cs = buildRipgrepArgs(base({ matchCase: true }), '/root')
    expect(cs).toContain('--case-sensitive')
    expect(cs).not.toContain('--ignore-case')
  })

  it('adds --word-regexp only when wholeWord', () => {
    expect(buildRipgrepArgs(base(), '/root')).not.toContain('--word-regexp')
    expect(buildRipgrepArgs(base({ wholeWord: true }), '/root')).toContain('--word-regexp')
  })

  it('uses --fixed-strings for literal search and drops it for regex', () => {
    expect(buildRipgrepArgs(base(), '/root')).toContain('--fixed-strings')
    expect(buildRipgrepArgs(base({ isRegex: true }), '/root')).not.toContain('--fixed-strings')
  })

  it('passes --context only for positive contextLines', () => {
    expect(buildRipgrepArgs(base(), '/root')).not.toContain('--context')
    expect(valueAfter(buildRipgrepArgs(base({ contextLines: 2 }), '/root'), '--context')).toBe('2')
  })

  it('maps includes to globs and excludes to negated globs', () => {
    const args = buildRipgrepArgs(
      base({ includes: ['src/**', '*.ts'], excludes: ['*.lock'] }),
      '/root',
      ['node_modules', '.git'],
    )
    const globs = args.filter((_, i) => args[i - 1] === '--glob')
    expect(globs).toContain('src/**')
    expect(globs).toContain('*.ts')
    expect(globs).toContain('!*.lock')
    expect(globs).toContain('!node_modules')
    expect(globs).toContain('!.git')
  })

  it('ignores blank include/exclude entries', () => {
    const args = buildRipgrepArgs(base({ includes: ['  ', ''], excludes: [' '] }), '/root')
    const globs = args.filter((_, i) => args[i - 1] === '--glob')
    expect(globs).toHaveLength(0)
  })

  it('passes the query via -e and the root path as the final argument', () => {
    const args = buildRipgrepArgs(base({ query: '-flag-like' }), '/my/root')
    expect(valueAfter(args, '-e')).toBe('-flag-like')
    expect(args[args.length - 1]).toBe('/my/root')
  })
})
