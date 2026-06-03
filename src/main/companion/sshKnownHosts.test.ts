import { describe, expect, test } from 'vitest'
import { evaluateHostKey, hostKeyId } from './sshKnownHosts'

// The on-disk store needs electron (app.getPath); the security-relevant logic is
// the pure TOFU decision, which is what we test here.
describe('evaluateHostKey (TOFU policy)', () => {
  test('trusts a host on first sight (no pin yet)', () => {
    expect(evaluateHostKey(null, 'aa:bb')).toBe('trust-on-first-use')
    expect(evaluateHostKey(undefined, 'aa:bb')).toBe('trust-on-first-use')
    expect(evaluateHostKey('', 'aa:bb')).toBe('trust-on-first-use')
  })

  test('accepts an exact match against the pinned key', () => {
    expect(evaluateHostKey('deadbeef', 'deadbeef')).toBe('match')
  })

  test('rejects a changed key (mismatch → MITM / server rebuild)', () => {
    expect(evaluateHostKey('deadbeef', 'feedface')).toBe('mismatch')
  })

  test('is case- and value-sensitive (no partial / prefix trust)', () => {
    expect(evaluateHostKey('abc', 'ABC')).toBe('mismatch')
    expect(evaluateHostKey('abc', 'abcd')).toBe('mismatch')
  })
})

describe('hostKeyId', () => {
  test('keys by host:port, defaulting the port to 22', () => {
    expect(hostKeyId('example.com')).toBe('example.com:22')
    expect(hostKeyId('example.com', 2222)).toBe('example.com:2222')
  })

  test('two ports on the same host are distinct pins', () => {
    expect(hostKeyId('h', 22)).not.toBe(hostKeyId('h', 2200))
  })
})
