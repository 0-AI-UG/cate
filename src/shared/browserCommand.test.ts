import { describe, expect, it } from 'vitest'
import {
  browserCommandShowsActivity,
  isReadOnlyBrowserCommand,
  validateBrowserCommand,
} from './browserCommand'
import { cliPermissionForRequest } from './cliPermissions'

describe('browser command boundary', () => {
  it('separates observing and acting commands', () => {
    expect(isReadOnlyBrowserCommand(['snapshot', '-i'])).toBe(true)
    expect(isReadOnlyBrowserCommand(['console'])).toBe(true)
    expect(isReadOnlyBrowserCommand(['console', '--clear'])).toBe(false)
    expect(isReadOnlyBrowserCommand(['wait', '--text', 'Ready'])).toBe(true)
    expect(isReadOnlyBrowserCommand(['wait', '--fn', 'document.body.remove()'])).toBe(false)
    expect(isReadOnlyBrowserCommand(['click', '@s1e1'])).toBe(false)
  })

  it('rejects target, process, and filesystem escape hatches', () => {
    expect(() => validateBrowserCommand(['connect', '9222'])).toThrow()
    expect(() => validateBrowserCommand(['tab', 'new'])).toThrow()
    expect(() => validateBrowserCommand(['click', '#x', '--cdp', '9222'])).toThrow()
    expect(() => validateBrowserCommand(['click', '#x', '--session=other'])).toThrow()
    expect(() => validateBrowserCommand(['get', 'cdp-url'])).toThrow()
    expect(() => validateBrowserCommand(['screenshot', '/tmp/x.png'])).toThrow()
    expect(() => validateBrowserCommand(['wait', '--download', '/tmp/x.zip'])).toThrow()
    expect(() => validateBrowserCommand(['upload', '#file'])).toThrow()
  })

  it('allows revisioned Cate refs and marks visible actions', () => {
    expect(validateBrowserCommand(['screenshot', '@s3e9', '--full']))
      .toEqual(['screenshot', '@s3e9', '--full'])
    expect(() => validateBrowserCommand(['screenshot', '--annotate'])).toThrow()
    expect(() => validateBrowserCommand(['snapshot', '--compact'])).toThrow()
    expect(browserCommandShowsActivity(['fill', '@s1e1', 'x'])).toBe(true)
    expect(validateBrowserCommand(['upload', '#file', '/tmp/user-picked.txt']))
      .toEqual(['upload', '#file', '/tmp/user-picked.txt'])
    expect(browserCommandShowsActivity(['upload', '#file', '/tmp/user-picked.txt'])).toBe(true)
    expect(browserCommandShowsActivity(['snapshot'])).toBe(false)
    expect(validateBrowserCommand(['wait', '@s2e2', '--state', 'visible', '--timeout', '3000']))
      .toEqual(['wait', '@s2e2', '--state', 'visible', '--timeout', '3000'])
  })

  it('cannot smuggle an action through the read permission envelope', () => {
    expect(cliPermissionForRequest('cate.browser.readCommand', {
      command: ['snapshot', '-i'],
    })?.key).toBe('cliBrowserReadEnabled')
    expect(cliPermissionForRequest('cate.browser.readCommand', {
      command: ['click', '@s1e1'],
    })?.key).toBe('cliBrowserControlEnabled')
    expect(cliPermissionForRequest('cate.browser.readCommand', {
      command: ['wait', '--fn', 'document.body.remove()'],
    })?.key).toBe('cliBrowserControlEnabled')
  })
})
