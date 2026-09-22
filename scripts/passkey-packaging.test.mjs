import { expect, it } from 'vitest'
import packaging from './passkey-packaging.cjs'

const profile = () => ({
  TeamIdentifier: ['TESTTEAM'], ExpirationDate: new Date(Date.now() + 86400000).toISOString(),
  Entitlements: {
    'com.apple.application-identifier': 'TESTTEAM.com.cate.app',
    'com.apple.developer.web-browser.public-key-credential': true,
  },
})
it('uses the approved profile’s team and exact app identifier', () => {
  expect(packaging.profileEntitlements(profile())).toEqual({
    'com.apple.application-identifier': 'TESTTEAM.com.cate.app',
    'com.apple.developer.team-identifier': 'TESTTEAM',
    'com.apple.developer.web-browser.public-key-credential': true,
  })
})
it('rejects missing approval, mismatched apps, and expired profiles', () => {
  for (const mutate of [
    (p) => { p.Entitlements['com.apple.developer.web-browser.public-key-credential'] = false },
    (p) => { p.Entitlements['com.apple.application-identifier'] = 'TESTTEAM.other.app' },
    (p) => { p.ExpirationDate = '2020-01-01' },
    (p) => { p.ExpirationDate = 'invalid' },
  ]) {
    const p = profile()
    mutate(p)
    expect(() => packaging.profileEntitlements(p)).toThrow()
  }
})
