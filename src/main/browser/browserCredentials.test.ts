import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCipheriv, pbkdf2Sync } from 'crypto'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'

const state = vi.hoisted(() => ({ userData: '' }))
const nodeSqliteAvailable = typeof process.getBuiltinModule === 'function'
  && process.getBuiltinModule('node:sqlite') !== undefined

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(`cate-encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^cate-encrypted:/, ''),
  },
}))
vi.mock('../logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

import {
  clearBrowserCredentials,
  decryptChromePassword,
  getCredentialForFill,
  getBrowserCredentials,
  getCredentialSuggestions,
  importChromePasswordCsv,
  importChromePasswords,
  listChromePasswordProfiles,
  removeBrowserCredential,
} from './browserCredentials'

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
  await fsp.writeFile(path.join(chromeRoot, 'Local State'), JSON.stringify({
    profile: { info_cache: { Default: { name: 'Work' } } },
  }))

  const db = new DatabaseSync(path.join(profile, 'Login Data'))
  db.exec(`
    CREATE TABLE logins (
      origin_url TEXT,
      username_element TEXT,
      username_value TEXT,
      password_element TEXT,
      password_value BLOB,
      signon_realm TEXT,
      blacklisted_by_user INTEGER
    )
  `)
  db.prepare(`
    INSERT INTO logins (
      origin_url, username_element, username_value, password_element,
      password_value, signon_realm, blacklisted_by_user
    ) VALUES (?, ?, ?, ?, ?, ?, 0)
  `).run(
    'https://example.com/login',
    'email',
    'person@example.com',
    'password',
    encryptChromePassword(password, 'chrome-key'),
    'https://example.com/',
  )
  db.close()
}

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cate-browser-credentials-'))
  state.userData = path.join(root, 'Cate')
  await fsp.mkdir(state.userData, { recursive: true })
})

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

describe('Chrome password import', () => {
  it('implements Chromium macOS v10 decryption', () => {
    const encrypted = encryptChromePassword('secret', 'keychain-value')
    expect(decryptChromePassword(encrypted, 'keychain-value')).toBe('secret')
    expect(decryptChromePassword(encrypted, 'wrong-value')).toBeNull()
  })

  it.runIf(process.platform === 'darwin' && nodeSqliteAvailable)(
    'discovers profiles, re-encrypts imported passwords, and exposes only matching usernames',
    async () => {
      await createChromeProfile()
      expect(await listChromePasswordProfiles(chromeRoot)).toEqual([{
        id: 'chrome:Default',
        appName: 'Google Chrome',
        profileName: 'Work',
      }])

      await expect(importChromePasswords('chrome:Default', {
        chromeRoot,
        keychainPassword: 'chrome-key',
      })).resolves.toEqual({ imported: 1, skipped: 0, total: 1 })

      const onDisk = await fsp.readFile(path.join(state.userData, 'browser-credentials.json'), 'utf8')
      expect(onDisk).not.toContain('correct horse battery staple')
      const encryptedPassword = JSON.parse(onDisk).credentials[0].encryptedPassword as string
      expect(Buffer.from(encryptedPassword, 'base64').toString('utf8')).toMatch(/^cate-encrypted:/)

      const suggestions = await getCredentialSuggestions('https://example.com/account')
      expect(suggestions).toHaveLength(1)
      expect(suggestions[0]).toMatchObject({
        username: 'person@example.com',
        origin: 'https://example.com',
      })
      expect(suggestions[0]).not.toHaveProperty('password')
      expect(await getCredentialSuggestions('https://lookalike.example/account')).toEqual([])

      const credential = await getCredentialForFill(suggestions[0].id, 'https://example.com/login')
      expect(credential).toEqual({
        username: 'person@example.com',
        password: 'correct horse battery staple',
        usernameElement: 'email',
      })
      await clearBrowserCredentials()
      expect(await getCredentialSuggestions('https://example.com/login')).toEqual([])
    },
  )

  it.runIf(process.platform === 'darwin' && nodeSqliteAvailable)(
    'rejects renderer-supplied profile paths',
    async () => {
      await createChromeProfile()
      await expect(importChromePasswords('chrome:../Default', {
        chromeRoot,
        keychainPassword: 'chrome-key',
      })).rejects.toThrow('no longer importable')
    },
  )

  it('imports Chrome CSV exports with quoted fields on every platform', async () => {
    const csvPath = path.join(root, 'chrome-passwords.csv')
    await fsp.writeFile(csvPath, [
      'name,url,username,password,note',
      '"Example, Inc",https://example.com/login,person@example.com,"s,e""cret",',
      'Unsupported,ftp://example.com,ignored,ignored,',
    ].join('\r\n'))

    await expect(importChromePasswordCsv(csvPath)).resolves.toEqual({
      imported: 1,
      skipped: 1,
      total: 1,
    })
    const suggestions = await getCredentialSuggestions('https://example.com/account')
    expect(suggestions).toHaveLength(1)
    expect(await getBrowserCredentials()).toEqual(suggestions)
    await expect(getCredentialForFill(suggestions[0].id, 'https://example.com/login')).resolves.toMatchObject({
      username: 'person@example.com',
      password: 's,e"cret',
    })

    const onDisk = await fsp.readFile(path.join(state.userData, 'browser-credentials.json'), 'utf8')
    expect(onDisk).not.toContain('s,e"cret')

    await removeBrowserCredential(suggestions[0].id)
    expect(await getBrowserCredentials()).toEqual([])
  })
})
