import { describe, expect, it } from 'vitest'
import { authenticatedBrowserProxy, browserProxyConfig } from './browserProxy'

describe('native browser proxy configuration', () => {
  it('uses the system configuration by default', () => {
    expect(browserProxyConfig('  ')).toEqual({ mode: 'system' })
  })

  it('passes Chromium proxy rules and bypass lists through', () => {
    expect(browserProxyConfig('socks5://127.0.0.1:1080;bypass=*.internal,10.0.0.0/8')).toEqual({
      mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:1080', proxyBypassRules: '*.internal,10.0.0.0/8',
    })
    expect(browserProxyConfig('http=proxy:80;https=secure:443')).toEqual({
      mode: 'fixed_servers', proxyRules: 'http=proxy:80;https=secure:443', proxyBypassRules: '',
    })
  })

  it('delegates PAC evaluation to Chromium', () => {
    for (const url of ['https://proxy.corp/config.pac', 'https://proxy.corp/config.pac?v=2']) {
      expect(browserProxyConfig(url)).toEqual({ mode: 'pac_script', pacScript: url })
    }
    expect(browserProxyConfig('pac+https://proxy.corp/config')).toEqual({
      mode: 'pac_script', pacScript: 'https://proxy.corp/config',
    })
  })

  it('keeps decoded HTTP proxy credentials out of Chromium proxy rules', () => {
    const value = 'https://user%40corp:p%3Ass@[::1]:8443'
    expect(browserProxyConfig(value)).toEqual({ mode: 'fixed_servers', proxyRules: 'https://[::1]:8443', proxyBypassRules: '' })
    expect(authenticatedBrowserProxy(value)).toEqual({
      host: '::1', port: 8443, server: 'https://[::1]:8443', credentials: { username: 'user@corp', password: 'p:ss' },
    })
  })
})
