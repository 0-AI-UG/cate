// =============================================================================
// URL helpers used by BrowserPanel address bar.
//
// Regression: prior versions hard-coded an http(s)-only protocol prefix, which
// rewrote `file:///path/to/index.html` into `https://file:///...` and made
// local HTML files unreachable from the browser panel (issue #106).
// =============================================================================

import { describe, it, expect } from 'vitest'
import { isUrl, normalizeUrl } from './browserUrl'
import { pageLoadErrorFrom } from './browserLoadError'

describe('isUrl', () => {
  it('recognises absolute http(s) URLs', () => {
    expect(isUrl('http://example.com')).toBe(true)
    expect(isUrl('https://example.com/path')).toBe(true)
  })

  it('recognises file:// URLs', () => {
    expect(isUrl('file:///Users/foo/index.html')).toBe(true)
  })

  it('recognises POSIX absolute paths', () => {
    expect(isUrl('/Users/foo/index.html')).toBe(true)
    expect(isUrl('/etc/hosts')).toBe(true)
  })

  it('recognises Windows absolute paths', () => {
    expect(isUrl('C:\\Users\\foo\\index.html')).toBe(true)
    expect(isUrl('C:/Users/foo/index.html')).toBe(true)
  })

  it('recognises domains and localhost', () => {
    expect(isUrl('example.com')).toBe(true)
    expect(isUrl('localhost:3000')).toBe(true)
    expect(isUrl('myhost:8080/path')).toBe(true)
  })

  it('treats spaces as a search query', () => {
    expect(isUrl('how to use file://')).toBe(false)
  })

  it('recognises remote-workspace locators (never leaked to a search engine)', () => {
    expect(isUrl('cate-runtime://srv_x/%2Fhome%2Fdev%2Findex.html')).toBe(true)
  })

  it('treats single bare words as search queries', () => {
    expect(isUrl('react')).toBe(false)
  })
})

describe('normalizeUrl', () => {
  it('passes http(s) and about: through unchanged', () => {
    expect(normalizeUrl('http://example.com')).toBe('http://example.com')
    expect(normalizeUrl('https://example.com')).toBe('https://example.com')
    expect(normalizeUrl('about:blank')).toBe('about:blank')
  })

  it('passes file:// URLs through unchanged', () => {
    expect(normalizeUrl('file:///Users/foo/index.html')).toBe('file:///Users/foo/index.html')
  })

  it('passes remote-workspace locators through untouched (never rewritten to file:// or https://)', () => {
    const locator = 'cate-runtime://srv_x/%2Fhome%2Fdev%2Findex.html'
    expect(normalizeUrl(locator)).toBe(locator)
  })

  it('prepends file:// to POSIX absolute paths', () => {
    expect(normalizeUrl('/Users/foo/index.html')).toBe('file:///Users/foo/index.html')
  })

  it('escapes #, ?, and % in POSIX paths so they are not parsed as URL syntax', () => {
    expect(normalizeUrl('/tmp/a#b.html')).toBe('file:///tmp/a%23b.html')
    expect(normalizeUrl('/tmp/a?b.html')).toBe('file:///tmp/a%3Fb.html')
    expect(normalizeUrl('/tmp/100%done.html')).toBe('file:///tmp/100%25done.html')
  })

  it('converts Windows absolute paths to file:// URLs with forward slashes', () => {
    expect(normalizeUrl('C:\\Users\\foo\\index.html')).toBe('file:///C:/Users/foo/index.html')
    expect(normalizeUrl('C:/Users/foo/index.html')).toBe('file:///C:/Users/foo/index.html')
  })

  it('escapes URL syntax characters in Windows paths', () => {
    expect(normalizeUrl('C:\\tmp\\a#b.html')).toBe('file:///C:/tmp/a%23b.html')
  })

  it('prepends http:// for localhost variants', () => {
    expect(normalizeUrl('localhost')).toBe('http://localhost')
    expect(normalizeUrl('localhost:3000')).toBe('http://localhost:3000')
    expect(normalizeUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
  })

  it('prepends https:// for bare domains', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com')
    expect(normalizeUrl('example.com/path')).toBe('https://example.com/path')
  })
})

describe('pageLoadErrorFrom', () => {
  it('reports main-frame failures with their description', () => {
    expect(
      pageLoadErrorFrom({ errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', isMainFrame: true }),
    ).toBe('ERR_NAME_NOT_RESOLVED')
  })

  it('falls back to a generic message when the main-frame error has no description', () => {
    expect(pageLoadErrorFrom({ errorCode: -2, isMainFrame: true })).toBe('Failed to load page')
  })

  it('ignores subframe failures so a blocked tracker does not hide the page', () => {
    expect(
      pageLoadErrorFrom({ errorCode: -118, errorDescription: 'ERR_CONNECTION_TIMED_OUT', isMainFrame: false }),
    ).toBeNull()
  })

  it('ignores aborted loads (ERR_ABORTED) even on the main frame', () => {
    expect(
      pageLoadErrorFrom({ errorCode: -3, errorDescription: 'ERR_ABORTED', isMainFrame: true }),
    ).toBeNull()
  })

  it('treats a missing isMainFrame flag as a main-frame failure', () => {
    expect(pageLoadErrorFrom({ errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED' })).toBe(
      'ERR_NAME_NOT_RESOLVED',
    )
  })
})
