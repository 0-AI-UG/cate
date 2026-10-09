import { describe, expect, it } from 'vitest'
import { getDocumentType, joinPath, parentDir, pathDisplayName, pathHasPrefix, pathKey, relativeDisplayPath, toAbsolutePath, toRelativePath } from './paths'
import { textDelta } from './buffer'
import { base64ToBytes, bytesToBase64, contentHash } from './hash'

describe('path helpers', () => {
  it('compares Windows paths from different sources', () => {
    expect(pathKey('C:/Proj/')).toBe(pathKey('c:\\proj'))
    expect(pathKey('/Users/A/')).toBe('/Users/A')
  })

  it('matches a prefix on segment boundaries only', () => {
    expect(pathHasPrefix('/a/b/c', '/a/b')).toBe(true)
    expect(pathHasPrefix('/a/bcd', '/a/b')).toBe(false)
    expect(pathHasPrefix('C:\\a\\b', 'C:\\a')).toBe(true)
    expect(pathHasPrefix('/x', '/')).toBe(true)
  })

  it('converts between relative and absolute', () => {
    expect(toRelativePath('/r/src/a.ts', '/r/')).toBe('src/a.ts')
    expect(toRelativePath('/other/a.ts', '/r')).toBe('/other/a.ts')
    expect(toAbsolutePath('src/a.ts', '/r')).toBe('/r/src/a.ts')
    expect(toAbsolutePath('src/a.ts', 'C:\\r')).toBe('C:\\r\\src\\a.ts')
  })

  it('names paths for display', () => {
    expect(pathDisplayName('/a/b/')).toBe('b')
    expect(pathDisplayName('C:\\Users\\foo\\proj')).toBe('proj')
    expect(relativeDisplayPath('/r/a/b.ts', '/r')).toBe('a/b.ts')
    expect(relativeDisplayPath('/elsewhere/b.ts', '/r')).toBe('/elsewhere/b.ts')
    expect(getDocumentType('/a/B.PNG')).toBe('image')
    expect(getDocumentType('/a/b.ts')).toBeNull()
  })
})

describe('buffer helpers', () => {

  it('finds the smallest replacement', () => {
    expect(textDelta('abc', 'abc')).toBeNull()
    expect(textDelta('hello world', 'hello brave world')).toEqual({ index: 6, remove: 0, insert: 'brave ' })
    expect(textDelta('aXc', 'aYYc')).toEqual({ index: 1, remove: 1, insert: 'YY' })
    expect(textDelta('aaa', 'aa')).toEqual({ index: 2, remove: 1, insert: '' })
  })

  it('hashes text as UTF-8 bytes and round-trips base64', () => {
    expect(contentHash('é')).toBe(contentHash(new Uint8Array([0xc3, 0xa9])))
    const bytes = new Uint8Array([0, 1, 250, 255])
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
  })
})

describe('parentDir and joinPath', () => {
  it('keep the path style of the runtime, whatever the client', () => {
    expect(parentDir('C:\\p\\a.ts')).toBe('C:\\p')
    expect(parentDir('C:\\a.ts')).toBe('C:\\')
    expect(parentDir('/srv/app/a.ts')).toBe('/srv/app')
    expect(parentDir('/a.ts')).toBe('/')
    expect(parentDir('a.ts')).toBe('')
    expect(joinPath('C:\\p', 'b.ts')).toBe('C:\\p\\b.ts')
    expect(joinPath('/srv/app', 'b.ts')).toBe('/srv/app/b.ts')
    expect(joinPath('/', 'b.ts')).toBe('/b.ts')
  })
})
