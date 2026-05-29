import { describe, it, expect } from 'vitest'

import {
  parseTerminalFileMatches,
  resolveCandidatePath,
  isTerminalLinkModifier,
} from './terminalFileLinks'

describe('parseTerminalFileMatches', () => {
  it('parses path:line:col', () => {
    const text = '  at src/foo.ts:12:5'
    const [m] = parseTerminalFileMatches(text)
    expect(m.path).toBe('src/foo.ts')
    expect(m.line).toBe(12)
    expect(m.column).toBe(5)
    expect(text.slice(m.start, m.end)).toBe('src/foo.ts:12:5')
  })

  it('parses path:line (no column)', () => {
    const [m] = parseTerminalFileMatches('error src/a.ts:3')
    expect(m.path).toBe('src/a.ts')
    expect(m.line).toBe(3)
    expect(m.column).toBeUndefined()
  })

  it('parses a bare path (no line)', () => {
    const [m] = parseTerminalFileMatches('open ./lib/b.js now')
    expect(m.path).toBe('./lib/b.js')
    expect(m.line).toBeUndefined()
    expect(m.column).toBeUndefined()
  })

  it('parses an absolute path with line:col', () => {
    const [m] = parseTerminalFileMatches('/Users/x/proj/file.tsx:10:2')
    expect(m.path).toBe('/Users/x/proj/file.tsx')
    expect(m.line).toBe(10)
    expect(m.column).toBe(2)
  })

  it('parses a ../ relative path', () => {
    const [m] = parseTerminalFileMatches('../shared/types.ts:7')
    expect(m.path).toBe('../shared/types.ts')
    expect(m.line).toBe(7)
  })

  it('finds multiple matches on one line', () => {
    const ms = parseTerminalFileMatches('a/x.ts:1 and b/y.js:2')
    expect(ms.map((m) => m.path)).toEqual(['a/x.ts', 'b/y.js'])
    expect(ms.map((m) => m.line)).toEqual([1, 2])
  })

  it('excludes trailing punctuation', () => {
    const text = 'check src/foo.ts.'
    const [m] = parseTerminalFileMatches(text)
    expect(text.slice(m.start, m.end)).toBe('src/foo.ts')
  })

  it('ignores a bare filename without a slash', () => {
    expect(parseTerminalFileMatches('see README.md for info')).toEqual([])
  })

  it('ignores plain prose', () => {
    expect(parseTerminalFileMatches('hello world, nothing here')).toEqual([])
  })

  it('parses a Windows backslash relative path', () => {
    const [m] = parseTerminalFileMatches('error src\\foo.ts:12:5')
    expect(m.path).toBe('src\\foo.ts')
    expect(m.line).toBe(12)
    expect(m.column).toBe(5)
  })

  it('parses a Windows drive-letter absolute path (backslash)', () => {
    const [m] = parseTerminalFileMatches('at C:\\Users\\x\\foo.tsx:10:2')
    expect(m.path).toBe('C:\\Users\\x\\foo.tsx')
    expect(m.line).toBe(10)
    expect(m.column).toBe(2)
  })

  it('parses a Windows drive-letter absolute path (forward slash)', () => {
    const [m] = parseTerminalFileMatches('C:/Users/x/file.ts:3')
    expect(m.path).toBe('C:/Users/x/file.ts')
    expect(m.line).toBe(3)
  })

  it('parses a .\\ backslash relative path', () => {
    const [m] = parseTerminalFileMatches('open .\\lib\\b.js now')
    expect(m.path).toBe('.\\lib\\b.js')
    expect(m.line).toBeUndefined()
  })
})

describe('resolveCandidatePath', () => {
  it('returns absolute paths unchanged', () => {
    expect(resolveCandidatePath('/abs/x.ts', '/root')).toBe('/abs/x.ts')
  })

  it('joins relative paths onto the workspace root', () => {
    expect(resolveCandidatePath('src/x.ts', '/root')).toBe('/root/src/x.ts')
  })

  it('strips a leading ./ when joining', () => {
    expect(resolveCandidatePath('./src/x.ts', '/root')).toBe('/root/src/x.ts')
  })

  it('keeps ../ for the fs layer to resolve', () => {
    expect(resolveCandidatePath('../x.ts', '/root/sub')).toBe('/root/sub/../x.ts')
  })

  it('returns a Windows drive-letter absolute path unchanged', () => {
    expect(resolveCandidatePath('C:\\Users\\x\\foo.ts', 'C:\\root')).toBe('C:\\Users\\x\\foo.ts')
    expect(resolveCandidatePath('C:/Users/x/foo.ts', 'C:\\root')).toBe('C:/Users/x/foo.ts')
  })

  it('joins a Windows backslash relative path onto the root', () => {
    expect(resolveCandidatePath('src\\x.ts', 'C:\\root')).toBe('C:\\root/src\\x.ts')
  })

  it('strips a leading .\\ when joining', () => {
    expect(resolveCandidatePath('.\\src\\x.ts', 'C:\\root')).toBe('C:\\root/src\\x.ts')
  })
})

describe('isTerminalLinkModifier', () => {
  it('mac: Cmd is the modifier, Ctrl is not', () => {
    expect(isTerminalLinkModifier({ metaKey: true, ctrlKey: false }, true)).toBe(true)
    expect(isTerminalLinkModifier({ metaKey: false, ctrlKey: true }, true)).toBe(false)
    expect(isTerminalLinkModifier({ metaKey: false, ctrlKey: false }, true)).toBe(false)
  })

  it('non-mac: Ctrl is the modifier, Cmd is not', () => {
    expect(isTerminalLinkModifier({ metaKey: false, ctrlKey: true }, false)).toBe(true)
    expect(isTerminalLinkModifier({ metaKey: true, ctrlKey: false }, false)).toBe(false)
  })
})
