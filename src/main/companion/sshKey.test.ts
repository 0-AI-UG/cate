import { describe, it, expect } from 'vitest'
import { generateKeyPairSync } from 'crypto'
import { normalizeKeyPath, assertSupportedPrivateKey } from './sshKey'

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

describe('assertSupportedPrivateKey', () => {
  const rsaPem = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  }).privateKey

  it('accepts a supported (PEM RSA) key', async () => {
    await expect(assertSupportedPrivateKey(Buffer.from(rsaPem))).resolves.toBeUndefined()
  })

  it('rejects a PuTTY .ppk key by name', async () => {
    const ppk = Buffer.from('PuTTY-User-Key-File-2: ssh-rsa\nEncryption: none\n')
    await expect(assertSupportedPrivateKey(ppk)).rejects.toThrow(/PuTTY .ppk/)
  })

  it('rejects an unparseable key with a format error', async () => {
    await expect(assertSupportedPrivateKey(Buffer.from('not a key at all'))).rejects.toThrow(
      /Unsupported private key format/,
    )
  })

  // A real encrypted OpenSSH ed25519 key (passphrase: "secret"). ssh2 reports
  // "Encrypted private OpenSSH key detected, but no passphrase given" when parsed
  // without the passphrase — a passphrase issue, NOT a format one.
  const encryptedOpenSsh = [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABD/ytz5yG',
    'R3jCGc8Xe25WRCAAAAGAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAID1pLzdSdUt88qse',
    '4eULnQE7mWC9VUC6GqydmOkWkkyZAAAAkDgJEqQP9vCAsIg3yEo8ns+gZbXAHtVYg9zfmD',
    'vBIopt0wh7csE5GLQq9uiTj60MX7vdQyGnnd5lNJQJUHWX79Dq3AYvxhhpFsp611xBL8UP',
    'jr6NSoz/23ycaa8O9NpZRH9/69ZI7CnYECbVlIxVaCE8EHVDxgYHChStKj53zlBoeDD0b5',
    'kErzmo3N7OVsKgzA==',
    '-----END OPENSSH PRIVATE KEY-----',
    '',
  ].join('\n')

  it('does not treat an encrypted key with a missing passphrase as a format error', async () => {
    await expect(assertSupportedPrivateKey(Buffer.from(encryptedOpenSsh))).resolves.toBeUndefined()
  })

  it('accepts the encrypted key when the correct passphrase is supplied', async () => {
    await expect(assertSupportedPrivateKey(Buffer.from(encryptedOpenSsh), 'secret')).resolves.toBeUndefined()
  })
})
