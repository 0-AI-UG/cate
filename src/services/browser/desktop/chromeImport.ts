// Reading passwords out of Google Chrome on this client: a profile's Login
// Data (macOS, decrypted with the Keychain's "Chrome Safe Storage" key) or a
// Chrome password export CSV (any platform). The rows go to the runtime's
// `browserData.importPasswords`; nothing is stored here.

import { execFile } from 'node:child_process'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { credentialOrigin, type BrowserChromeImport, type BrowserChromeProfile, type BrowserCredentialImport } from '../contract'

const execFileAsync = promisify(execFile)
const MAX_CREDENTIALS = 20_000
const MAX_IMPORT_FILE_BYTES = 32 * 1024 * 1024
const CHROME_PREFIX = Buffer.from('v10')
const CHROME_IV = Buffer.alloc(16, 0x20)
const LOGIN_DATABASES = ['Login Data', 'Login Data For Account']

interface ChromeLoginRow {
  origin_url: string
  username_element: string
  username_value: string
  password_element: string
  password_value: Uint8Array
  signon_realm: string
}

export interface ChromeImportOptions {
  chromeRoot?: string
  keychainPassword?: string
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

function defaultChromeRoot(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
}

const profileId = (directory: string): string => `chrome:${directory}`

function profileDirectoryFromId(id: string): string | null {
  if (!id.startsWith('chrome:')) return null
  const directory = id.slice('chrome:'.length)
  if (!directory || directory === '.' || directory === '..' || directory.includes('/') || directory.includes('\\')) return null
  return directory
}

async function readLocalState(chromeRoot: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(path.join(chromeRoot, 'Local State'), 'utf8'))
    return isPlainObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

async function hasLoginDatabase(chromeRoot: string, directory: string): Promise<boolean> {
  for (const filename of LOGIN_DATABASES) {
    try {
      await fsp.access(path.join(chromeRoot, directory, filename))
      return true
    } catch {
      // Try the other Chrome password store.
    }
  }
  return false
}

export async function listChromePasswordProfiles(chromeRoot = defaultChromeRoot()): Promise<BrowserChromeProfile[]> {
  if (process.platform !== 'darwin') return []
  const state = await readLocalState(chromeRoot)
  const profile = isPlainObject(state.profile) ? state.profile : {}
  const infoCache = isPlainObject(profile.info_cache) ? profile.info_cache : {}
  const profiles: BrowserChromeProfile[] = []
  for (const [directory, rawInfo] of Object.entries(infoCache)) {
    if (!profileDirectoryFromId(profileId(directory)) || !await hasLoginDatabase(chromeRoot, directory)) continue
    const info = isPlainObject(rawInfo) ? rawInfo : {}
    profiles.push({
      id: profileId(directory),
      appName: 'Google Chrome',
      profileName: typeof info.name === 'string' && info.name ? info.name : directory,
    })
  }
  if (profiles.length === 0 && await hasLoginDatabase(chromeRoot, 'Default')) {
    profiles.push({ id: profileId('Default'), appName: 'Google Chrome', profileName: 'Default' })
  }
  return profiles
}

async function chromeSafeStoragePassword(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/security', [
      'find-generic-password', '-w', '-s', 'Chrome Safe Storage', '-a', 'Chrome',
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 })
    const password = stdout.replace(/\r?\n$/, '')
    if (password) return password
  } catch {
    // Do not log command output: it may contain sensitive Keychain details.
  }
  throw new Error('Chrome password access was not approved in Keychain')
}

/** Chromium macOS OSCrypt v10: PBKDF2-SHA1 + AES-128-CBC. */
export function decryptChromePassword(encrypted: Uint8Array, keychainPassword: string): string | null {
  const value = Buffer.from(encrypted)
  if (value.length <= CHROME_PREFIX.length || !value.subarray(0, 3).equals(CHROME_PREFIX)) return null
  try {
    const key = pbkdf2Sync(keychainPassword, 'saltysalt', 1003, 16, 'sha1')
    const decipher = createDecipheriv('aes-128-cbc', key, CHROME_IV)
    return Buffer.concat([decipher.update(value.subarray(3)), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

async function readLoginRows(databasePath: string): Promise<ChromeLoginRow[]> {
  const { DatabaseSync } = await import('node:sqlite')
  let db: InstanceType<typeof DatabaseSync> | null = null
  try {
    db = new DatabaseSync(databasePath, { readOnly: true })
    return db.prepare(`
      SELECT origin_url, username_element, username_value, password_element,
             password_value, signon_realm
      FROM logins
      WHERE blacklisted_by_user = 0 AND length(password_value) > 0
    `).all() as unknown as ChromeLoginRow[]
  } finally {
    db?.close()
  }
}

/** Reads and decrypts a Chrome profile's saved passwords (macOS only). */
export async function readChromePasswords(id: string, options: ChromeImportOptions = {}): Promise<BrowserChromeImport> {
  if (process.platform !== 'darwin') {
    throw new Error('Direct Chrome profile import is unavailable; use a Chrome password export instead')
  }
  const chromeRoot = options.chromeRoot ?? defaultChromeRoot()
  const directory = profileDirectoryFromId(id)
  const profiles = await listChromePasswordProfiles(chromeRoot)
  if (!directory || !profiles.some((profile) => profile.id === id)) throw new Error('Chrome profile is no longer importable')

  const keychainPassword = options.keychainPassword ?? await chromeSafeStoragePassword()
  const credentials: BrowserCredentialImport[] = []
  let skipped = 0
  for (const filename of LOGIN_DATABASES) {
    const databasePath = path.join(chromeRoot, directory, filename)
    try {
      await fsp.access(databasePath)
    } catch {
      continue
    }
    let rows: ChromeLoginRow[]
    try {
      rows = await readLoginRows(databasePath)
    } catch {
      skipped += 1
      continue
    }
    for (const row of rows) {
      const origin = credentialOrigin(row.origin_url)
      const password = decryptChromePassword(row.password_value, keychainPassword)
      if (!origin || password === null) {
        skipped += 1
        continue
      }
      credentials.push({
        origin,
        signonRealm: row.signon_realm || origin,
        username: row.username_value || '',
        usernameElement: row.username_element || '',
        passwordElement: row.password_element || '',
        password,
      })
    }
  }
  return { credentials, skipped }
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let value = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
      } else {
        value += character
      }
    } else if (character === '"' && value.length === 0) {
      quoted = true
    } else if (character === ',') {
      row.push(value)
      value = ''
    } else if (character === '\n') {
      row.push(value.endsWith('\r') ? value.slice(0, -1) : value)
      rows.push(row)
      row = []
      value = ''
    } else {
      value += character
    }
  }
  if (value || row.length > 0) {
    row.push(value.endsWith('\r') ? value.slice(0, -1) : value)
    rows.push(row)
  }
  return rows
}

/** Reads a Chrome password export CSV. */
export async function readChromePasswordCsv(filePath: string): Promise<BrowserChromeImport> {
  const stats = await fsp.stat(filePath)
  if (!stats.isFile() || stats.size > MAX_IMPORT_FILE_BYTES) throw new Error('The selected password export is not a supported CSV file')
  const rows = parseCsv(await fsp.readFile(filePath, 'utf8'))
  const header = rows.shift()?.map((column, index) =>
    (index === 0 ? column.replace(/^\uFEFF/, '') : column).trim().toLowerCase())
  if (!header) throw new Error('The selected password export is empty')
  const urlIndex = header.findIndex((column) => ['url', 'origin', 'origin_url'].includes(column))
  const usernameIndex = header.findIndex((column) => ['username', 'username_value'].includes(column))
  const passwordIndex = header.findIndex((column) => ['password', 'password_value'].includes(column))
  if (urlIndex < 0 || usernameIndex < 0 || passwordIndex < 0) throw new Error('The selected file is not a Chrome password export')

  const credentials: BrowserCredentialImport[] = []
  let skipped = 0
  for (const columns of rows.slice(0, MAX_CREDENTIALS)) {
    if (columns.every((column) => column === '')) continue
    const origin = credentialOrigin(columns[urlIndex] ?? '')
    const password = columns[passwordIndex] ?? ''
    if (!origin || !password) {
      skipped += 1
      continue
    }
    credentials.push({ origin, signonRealm: origin, username: columns[usernameIndex] ?? '', password })
  }
  skipped += Math.max(0, rows.length - MAX_CREDENTIALS)
  return { credentials, skipped }
}
