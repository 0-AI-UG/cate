import { describe, it, expect, vi, afterEach } from 'vitest'
import { toAbsolutePath, toRelativePath, pathKey } from './pathUtils'

describe('toAbsolutePath', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('joins a relative path under a POSIX root with forward slashes', () => {
    expect(toAbsolutePath('src/a.ts', '/Users/x/proj')).toBe('/Users/x/proj/src/a.ts')
  })

  it('derives Windows separators from a drive-letter root, regardless of host platform', () => {
    expect(toAbsolutePath('src/a.ts', 'C:/Users/x/proj')).toBe('C:\\Users\\x\\proj\\src\\a.ts')
  })

  it('derives Windows separators from a backslash root', () => {
    expect(toAbsolutePath('src\\a.ts', 'C:\\proj')).toBe('C:\\proj\\src\\a.ts')
  })

  it('returns an already-absolute POSIX path unchanged', () => {
    expect(toAbsolutePath('/abs/a.ts', '/Users/x/proj')).toBe('/abs/a.ts')
  })

  it('returns an already-absolute Windows path unchanged', () => {
    expect(toAbsolutePath('D:/abs/a.ts', 'C:/proj')).toBe('D:/abs/a.ts')
  })

  // Regression: the renderer has no Node `process` global. The helper must not
  // reference it, or restoring a workspace throws "process is not defined" and
  // the canvas fails to rebuild from .cate/workspace.json.
  it('does not depend on the Node `process` global (renderer-safe)', () => {
    vi.stubGlobal('process', undefined)
    expect(() => toAbsolutePath('src/a.ts', '/Users/x/proj')).not.toThrow()
    expect(toAbsolutePath('src/a.ts', '/Users/x/proj')).toBe('/Users/x/proj/src/a.ts')
  })
})

describe('pathKey', () => {
  it('keeps a POSIX path case-sensitive and unchanged (minus trailing slash)', () => {
    expect(pathKey('/Users/X/Proj')).toBe('/Users/X/Proj')
    expect(pathKey('/Users/X/Proj/')).toBe('/Users/X/Proj')
  })

  it('makes a Windows backslash path and the git forward-slash form compare equal', () => {
    expect(pathKey('C:\\Users\\me\\Proj')).toBe(pathKey('C:/Users/me/proj'))
  })

  it('lower-cases Windows paths (case-insensitive filesystem)', () => {
    expect(pathKey('C:\\Proj\\X')).toBe('c:/proj/x')
  })

  it('does not depend on the Node `process` global (renderer-safe)', () => {
    vi.stubGlobal('process', undefined)
    expect(() => pathKey('C:\\proj')).not.toThrow()
  })

  afterEach(() => vi.unstubAllGlobals())
})

describe('toRelativePath', () => {
  it('strips the root prefix', () => {
    expect(toRelativePath('/Users/x/proj/src/a.ts', '/Users/x/proj')).toBe('src/a.ts')
  })

  it('leaves a path outside the root unchanged', () => {
    expect(toRelativePath('/other/a.ts', '/Users/x/proj')).toBe('/other/a.ts')
  })
})
