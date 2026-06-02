import { describe, expect, test } from 'vitest'
import {
  LOCAL_COMPANION_ID,
  parseLocator,
  formatLocator,
  isLocalLocator,
  type ResourceLocator,
} from './locator'

describe('locator', () => {
  describe('parseLocator', () => {
    test('treats a bare POSIX path as local', () => {
      expect(parseLocator('/Users/anton/proj')).toEqual({
        companionId: LOCAL_COMPANION_ID,
        path: '/Users/anton/proj',
      })
    })

    test('treats a bare Windows path as local (drive letter is not a scheme)', () => {
      expect(parseLocator('C:\\Users\\anton\\proj')).toEqual({
        companionId: LOCAL_COMPANION_ID,
        path: 'C:\\Users\\anton\\proj',
      })
    })

    test('decodes a remote URI into companion + posix path', () => {
      expect(parseLocator('cate-companion://srv_a1b2c3/home/me/proj')).toEqual({
        companionId: 'srv_a1b2c3',
        path: '/home/me/proj',
      })
    })

    test('percent-decodes path segments', () => {
      expect(parseLocator('cate-companion://wsl_ubuntu/home/my%20proj/a%23b.ts')).toEqual({
        companionId: 'wsl_ubuntu',
        path: '/home/my proj/a#b.ts',
      })
    })

    test('handles an authority with no path component', () => {
      expect(parseLocator('cate-companion://srv_x')).toEqual({
        companionId: 'srv_x',
        path: '',
      })
    })
  })

  describe('formatLocator', () => {
    test('local companion yields the bare path (no scheme)', () => {
      expect(formatLocator({ companionId: LOCAL_COMPANION_ID, path: '/Users/anton/proj' })).toBe(
        '/Users/anton/proj',
      )
    })

    test('remote companion yields a percent-encoded URI', () => {
      expect(formatLocator({ companionId: 'srv_x', path: '/home/my proj/a#b.ts' })).toBe(
        'cate-companion://srv_x/home/my%20proj/a%23b.ts',
      )
    })
  })

  describe('round-trips', () => {
    const locators: ResourceLocator[] = [
      { companionId: LOCAL_COMPANION_ID, path: '/Users/anton/proj' },
      { companionId: LOCAL_COMPANION_ID, path: 'C:\\Users\\anton\\proj' },
      { companionId: 'srv_a1b2c3', path: '/home/me/proj' },
      { companionId: 'wsl_Ubuntu-22.04', path: '/home/me/my proj/src' },
      { companionId: 'srv_x', path: '/weird/päth/with #&?/chars' },
    ]

    test.each(locators)('struct -> string -> struct is stable (%o)', (loc) => {
      expect(parseLocator(formatLocator(loc))).toEqual(loc)
    })

    const canonicalStrings = [
      '/Users/anton/proj',
      'C:\\Users\\anton\\proj',
      'cate-companion://srv_a1b2c3/home/me/proj',
      'cate-companion://wsl_ubuntu/home/my%20proj/a%23b.ts',
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
      expect(isLocalLocator('cate-companion://srv_x/home/me')).toBe(false)
    })
  })
})
