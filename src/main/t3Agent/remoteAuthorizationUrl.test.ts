import { describe, expect, it } from 'vitest'
import { remoteAuthorizationUrl } from './remoteAuthorizationUrl'

describe('remoteAuthorizationUrl', () => {
  const url = `https://app.t3.codes/connect#state=${'a'.repeat(22)}&challenge=${'b'.repeat(43)}&port=34338`
  it('accepts the complete request printed by the pinned T3 CLI', () => {
    expect(remoteAuthorizationUrl(`Open this URL: ${url}`)).toBeUndefined()
    expect(remoteAuthorizationUrl(`Headless authorization\r\nOpen this URL on a device with a browser:\r\n  ${url}\r\n`)).toBe(url)
  })

  it('never opens a partial or unrelated URL', () => {
    expect(remoteAuthorizationUrl('https://app.t3.codes/connect')).toBeUndefined()
    expect(remoteAuthorizationUrl(`https://app.t3.codes/connect#state=${'a'.repeat(22)}&challenge=b\n`)).toBeUndefined()
    expect(remoteAuthorizationUrl(`https://app.t3.codes/connect#state=${'a'.repeat(22)}&challenge=${'b'.repeat(43)}\n`)).toBeUndefined()
    expect(remoteAuthorizationUrl(`${url.replace('port=34338', 'port=70000')}\n`)).toBeUndefined()
    expect(remoteAuthorizationUrl(`https://example.test/connect#state=${'a'.repeat(22)}&challenge=${'b'.repeat(43)}\n${url}\n`))
      .toBe(url)
  })
})
