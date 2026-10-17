import { createCipheriv, pbkdf2Sync } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decryptChromePassword, listChromePasswordProfiles, readChromePasswordCsv, readChromePasswords } from './chromeImport'

const nodeSqliteAvailable = typeof process.getBuiltinModule === 'function'
  && process.getBuiltinModule('node:sqlite') !== undefined

let root = ''
let chromeRoot = ''

function encryptChromePassword(password: string, keychainPassword: string): Buffer {
  const key = pbkdf2Sync(keychainPassword, 'saltysalt', 1003, 16, 'sha1')
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  return Buffer.concat([Buffer.from('v10'), cipher.update(password, 'utf8'), cipher.final()])
}

async function createChromeProfile(password = 'correct horse battery staple'): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite')
  chromeRoot = path.join(root, 'Chrome')
  const profile = path.join(chromeRoot, 'Default')
  await fsp.mkdir(profile, { recursive: true })
  await fsp.writeFile(path.join(chromeRoot, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Work' } } } }))
  const db = new DatabaseSync(path.join(profile, 'Login Data'))
  db.exec(`CREATE TABLE logins (origin_url TEXT, username_element TEXT, username_value TEXT, password_element TEXT,
    password_value BLOB, signon_realm TEXT, blacklisted_by_user INTEGER)`)
  db.prepare(`INSERT INTO logins (origin_url, username_element, username_value, password_element, password_value,
    signon_realm, blacklisted_by_user) VALUES (?, ?, ?, ?, ?, ?, 0)`).run(
    'https://example.com/login', 'email', 'person@example.com', 'password',
    encryptChromePassword(password, 'chrome-key'), 'https://example.com/',
  )
  db.close()
}

beforeEach(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cate-chrome-import-')) })
afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }) })

describe('Chrome password import', () => {
  it('implements Chromium macOS v10 decryption', () => {
    const encrypted = encryptChromePassword('secret', 'keychain-value')
    expect(decryptChromePassword(encrypted, 'keychain-value')).toBe('secret')
    expect(decryptChromePassword(encrypted, 'wrong-value')).toBeNull()
  })

  it.runIf(process.platform === 'darwin' && nodeSqliteAvailable)('discovers profiles and reads their passwords', async () => {
    await createChromeProfile()
    expect(await listChromePasswordProfiles(chromeRoot)).toEqual([{ id: 'chrome:Default', appName: 'Google Chrome', profileName: 'Work' }])
    await expect(readChromePasswords('chrome:Default', { chromeRoot, keychainPassword: 'chrome-key' })).resolves.toEqual({
      skipped: 0,
      credentials: [{
        origin: 'https://example.com',
        signonRealm: 'https://example.com/',
        username: 'person@example.com',
        usernameElement: 'email',
        passwordElement: 'password',
        password: 'correct horse battery staple',
      }],
    })
  })

  it.runIf(process.platform === 'darwin' && nodeSqliteAvailable)('rejects renderer-supplied profile paths', async () => {
    await createChromeProfile()
    await expect(readChromePasswords('chrome:../Default', { chromeRoot, keychainPassword: 'chrome-key' }))
      .rejects.toThrow('no longer importable')
  })

  it('reads Chrome CSV exports with quoted fields on every platform', async () => {
    const csvPath = path.join(root, 'chrome-passwords.csv')
    await fsp.writeFile(csvPath, [
      'name,url,username,password,note',
      '"Example, Inc",https://example.com/login,person@example.com,"s,e""cret",',
      'Unsupported,ftp://example.com,ignored,ignored,',
    ].join('\r\n'))
    await expect(readChromePasswordCsv(csvPath)).resolves.toEqual({
      skipped: 1,
      credentials: [{ origin: 'https://example.com', signonRealm: 'https://example.com', username: 'person@example.com', password: 's,e"cret' }],
    })
  })
})
