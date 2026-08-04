import { describe, it, expect } from 'vitest'
import { normalizeKeyPath, assertNotPuttyKey } from './sshKey'

describe('normalizeKeyPath', () => {
  it('strips a single pair of surrounding double quotes', () => {
    expect(normalizeKeyPath('"C:\\Users\\me\\key.pem"')).toBe('C:\\Users\\me\\key.pem')
  })

  it('strips surrounding single quotes', () => {
    expect(normalizeKeyPath("'/home/me/.ssh/id_ed25519'")).toBe('/home/me/.ssh/id_ed25519')
  })

  it('trims whitespace inside and outside the quotes', () => {
    expect(normalizeKeyPath('  " /home/me/key "  ')).toBe('/home/me/key')
  })

  it('expands a leading ~ (posix)', () => {
    expect(normalizeKeyPath('~/.ssh/id_rsa', '/home/me')).toBe('/home/me/.ssh/id_rsa')
  })

  it('expands a bare ~', () => {
    expect(normalizeKeyPath('~', '/home/me')).toBe('/home/me')
  })

  it('does not expand ~ in the middle of a path', () => {
    expect(normalizeKeyPath('/tmp/~/key', '/home/me')).toBe('/tmp/~/key')
  })

  it('leaves an unquoted, plain path untouched', () => {
    expect(normalizeKeyPath('/home/me/.ssh/id_ed25519')).toBe('/home/me/.ssh/id_ed25519')
  })

  it('does not strip a single leading quote (unbalanced)', () => {
    expect(normalizeKeyPath('"C:\\Users\\me\\key.pem')).toBe('"C:\\Users\\me\\key.pem')
  })
})

describe('assertNotPuttyKey', () => {
  it('rejects a PuTTY .ppk key by name', () => {
    const ppk = Buffer.from('PuTTY-User-Key-File-2: ssh-rsa\nEncryption: none\n')
    expect(() => assertNotPuttyKey(ppk)).toThrow(/PuTTY .ppk/)
  })

  it('delegates every other identity format to OpenSSH', () => {
    expect(() => assertNotPuttyKey(Buffer.from('not parsed by Cate'))).not.toThrow()
  })
})
