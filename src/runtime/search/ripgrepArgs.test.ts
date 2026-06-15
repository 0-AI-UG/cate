import { describe, it, expect } from 'vitest'
import { buildRipgrepArgs } from './ripgrepArgs'
import type { SearchOptions } from '../../shared/types'

const base = (over: Partial<SearchOptions> = {}): SearchOptions => ({ query: 'foo', ...over })

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

  it('respects ignore files by default and applies the project exclusion set', () => {
    const args = buildRipgrepArgs(base(), '/root', ['node_modules', '.git'])
    expect(args).not.toContain('--no-ignore')
    expect(args).not.toContain('--hidden')
    const globs = args.filter((_, i) => args[i - 1] === '--glob')
    expect(globs).toContain('!node_modules')
    expect(globs).toContain('!.git')
  })

  it('with respectIgnore=false adds --no-ignore --hidden and drops the project exclusion set', () => {
    const args = buildRipgrepArgs(
      base({ respectIgnore: false, excludes: ['*.lock'] }),
      '/root',
      ['node_modules', '.git'],
    )
    expect(args).toContain('--no-ignore')
    expect(args).toContain('--hidden')
    const globs = args.filter((_, i) => args[i - 1] === '--glob')
    expect(globs).toContain('!*.lock') // user excludes still apply
    expect(globs).not.toContain('!node_modules') // project exclusion set dropped
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

  it('ignores blank include/exclude entries (only the always-on !.git remains)', () => {
    const args = buildRipgrepArgs(base({ includes: ['  ', ''], excludes: [' '] }), '/root')
    const globs = args.filter((_, i) => args[i - 1] === '--glob')
    expect(globs).toEqual(['!.git'])
  })

  it('always excludes the .git directory', () => {
    const globs = buildRipgrepArgs(base({ respectIgnore: false }), '/root').filter(
      (_, i, a) => a[i - 1] === '--glob',
    )
    expect(globs).toContain('!.git')
  })

  it('passes the query via -e and the root path as the final argument', () => {
    const args = buildRipgrepArgs(base({ query: '-flag-like' }), '/my/root')
    expect(args[args.indexOf('-e') + 1]).toBe('-flag-like')
    expect(args[args.length - 1]).toBe('/my/root')
  })
})
