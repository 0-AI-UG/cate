import { describe, expect, it } from 'vitest'
import { passkeyRelyingParty, validatePasskeyRequest } from './passkeyPolicy'

describe('passkey relying party security', () => {
  it('allows the origin and registrable parent domains', () => {
    expect(passkeyRelyingParty('https://login.example.com')).toBe('login.example.com')
    expect(passkeyRelyingParty('https://login.example.com', 'example.com')).toBe('example.com')
    expect(passkeyRelyingParty('http://localhost:1234')).toBe('localhost')
  })
  it.each(['com', 'co.uk', 'github.io', 'other.com', 'example.com.evil.com', '', 'EXAMPLE.COM'])('rejects invalid RP %s', (rp) => {
    expect(() => passkeyRelyingParty('https://login.example.com', rp)).toThrow()
  })
  it.each(['http://example.com', 'file:///tmp/login.html', 'https://127.0.0.1'])('rejects non-domain/insecure origins %s', (origin) => {
    expect(() => passkeyRelyingParty(origin)).toThrow()
  })
  it('rejects private public suffixes even for their tenants', () => {
    expect(() => passkeyRelyingParty('https://tenant.github.io', 'github.io')).toThrow()
  })
  it('rejects malformed buffers and unsupported extensions', () => {
    expect(() => validatePasskeyRequest('get', { challenge: [] }, 'https://example.com')).toThrow()
    expect(() => validatePasskeyRequest('get', { challenge: 'YQ', extensions: { prf: {} } }, 'https://example.com')).toThrow()
  })
})
