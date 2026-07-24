import { describe, expect, test } from 'vitest'
import {
  LOCAL_RUNTIME_ID,
  parseLocator,
  formatLocator,
  isLocalLocator,
  isRuntimeLocator,
  type ResourceLocator,
} from './runtimeLocator'

describe('locator', () => {
  describe('parseLocator', () => {
    test('treats a bare POSIX path as local', () => {
      expect(parseLocator('/Users/anton/proj')).toEqual({
        runtimeId: LOCAL_RUNTIME_ID,
        path: '/Users/anton/proj',
      })
    })

    test('treats a bare Windows path as local (drive letter is not a scheme)', () => {
      expect(parseLocator('C:\\Users\\anton\\proj')).toEqual({
        runtimeId: LOCAL_RUNTIME_ID,
        path: 'C:\\Users\\anton\\proj',
      })
    })

    test('decodes a remote URI into runtime + posix path', () => {
      expect(parseLocator('cate-runtime://srv_a1b2c3/home/me/proj')).toEqual({
        runtimeId: 'srv_a1b2c3',
        path: '/home/me/proj',
      })
    })

    test('percent-decodes path segments', () => {
      expect(parseLocator('cate-runtime://wsl_ubuntu/home/my%20proj/a%23b.ts')).toEqual({
        runtimeId: 'wsl_ubuntu',
        path: '/home/my proj/a#b.ts',
      })
    })

    test('handles an authority with no path component', () => {
      expect(parseLocator('cate-runtime://srv_x')).toEqual({
        runtimeId: 'srv_x',
        path: '',
      })
    })
  })

  describe('formatLocator', () => {
    test('local runtime yields the bare path (no scheme)', () => {
      expect(formatLocator({ runtimeId: LOCAL_RUNTIME_ID, path: '/Users/anton/proj' })).toBe(
        '/Users/anton/proj',
      )
    })

    test('remote runtime yields a percent-encoded URI', () => {
      expect(formatLocator({ runtimeId: 'srv_x', path: '/home/my proj/a#b.ts' })).toBe(
        'cate-runtime://srv_x/home/my%20proj/a%23b.ts',
      )
    })
  })

  describe('round-trips', () => {
    const locators: ResourceLocator[] = [
      { runtimeId: LOCAL_RUNTIME_ID, path: '/Users/anton/proj' },
      { runtimeId: LOCAL_RUNTIME_ID, path: 'C:\\Users\\anton\\proj' },
      { runtimeId: 'srv_a1b2c3', path: '/home/me/proj' },
      { runtimeId: 'wsl_Ubuntu-22.04', path: '/home/me/my proj/src' },
      { runtimeId: 'srv_x', path: '/weird/päth/with #&?/chars' },
    ]

    test.each(locators)('struct -> string -> struct is stable (%o)', (loc) => {
      expect(parseLocator(formatLocator(loc))).toEqual(loc)
    })

    const canonicalStrings = [
      '/Users/anton/proj',
      'C:\\Users\\anton\\proj',
      'cate-runtime://srv_a1b2c3/home/me/proj',
      'cate-runtime://wsl_ubuntu/home/my%20proj/a%23b.ts',
    ]

    test.each(canonicalStrings)('canonical string -> struct -> string is stable (%s)', (s) => {
      expect(formatLocator(parseLocator(s))).toBe(s)
    })
  })

  describe('isLocalLocator', () => {
    test('bare paths are local', () => {
      expect(isLocalLocator('/Users/anton/proj')).toBe(true)
      expect(isLocalLocator('C:\\proj')).toBe(true)
    })

    test('remote URIs are not local', () => {
      expect(isLocalLocator('cate-runtime://srv_x/home/me')).toBe(false)
    })
  })

  describe('isRuntimeLocator', () => {
    test('recognizes only explicitly encoded runtime locators', () => {
      expect(isRuntimeLocator('cate-runtime://srv_x/home/me')).toBe(true)
      expect(isRuntimeLocator('/Users/anton/proj')).toBe(false)
      expect(isRuntimeLocator(undefined)).toBe(false)
    })
  })
})
