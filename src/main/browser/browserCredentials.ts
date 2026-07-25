// Chrome password import + Cate-owned credential store.
//
// Import is explicit. Cate can read a supported local Chrome profile directly,
// or import Chrome's portable CSV export on any platform. Passwords are
// immediately re-encrypted with Electron safeStorage under userData.
// Password plaintext is never returned to the renderer or browser-agent APIs.

import { execFile } from 'child_process'
import { createDecipheriv, pbkdf2Sync, randomUUID } from 'crypto'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { app, safeStorage } from 'electron'
import type {
  BrowserCredentialProfile,
  BrowserCredentialProfilesResult,
  BrowserCredentialSuggestion,
} from '../../shared/types'
import { isPlainObject } from '../jsonUtils'
import { writeJsonAtomic } from '../writeJsonAtomic'
import log from '../logger'

const execFileAsync = promisify(execFile)
const STORE_VERSION = 1
const MAX_CREDENTIALS = 20_000
const MAX_IMPORT_FILE_BYTES = 32 * 1024 * 1024
const CHROME_PREFIX = Buffer.from('v10')
const CHROME_IV = Buffer.alloc(16, 0x20)

interface StoredCredential {
  id: string
  origin: string
  signonRealm: string
  username: string
  usernameElement: string
  passwordElement: string
  encryptedPassword: string
  importedAt: number
}

interface CredentialFile {
  version: number
  credentials: StoredCredential[]
}

interface ChromeLoginRow {
  origin_url: string
  username_element: string
  username_value: string
  password_element: string
  password_value: Uint8Array
  signon_realm: string
}

interface ImportOptions {
  chromeRoot?: string
  keychainPassword?: string
}

interface PlainCredential {
  origin: string
  signonRealm: string
  username: string
  usernameElement: string
  passwordElement: string
  password: string
}

function storePath(): string {
  return path.join(app.getPath('userData'), 'browser-credentials.json')
}

function defaultChromeRoot(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
}

function profileId(directory: string): string {
  return `chrome:${directory}`
}

function profileDirectoryFromId(id: string): string | null {
  if (!id.startsWith('chrome:')) return null
  const directory = id.slice('chrome:'.length)
  if (!directory || directory === '.' || directory === '..' || directory.includes('/') || directory.includes('\\')) {
    return null
  }
  return directory
}

function normalizeOrigin(value: string): string | null {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.origin
  } catch {
    return null
  }
}

function secureStorageAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
}

function assertSecureStorageAvailable(): void {
  if (!secureStorageAvailable()) {
    throw new Error('Operating-system secure storage is unavailable; passwords were not imported')
  }
}

function normalizeStoredCredential(value: unknown): StoredCredential | null {
  if (!isPlainObject(value)) return null
  const origin = typeof value.origin === 'string' ? normalizeOrigin(value.origin) : null
  if (
    !origin
    || typeof value.id !== 'string'
    || typeof value.signonRealm !== 'string'
    || typeof value.username !== 'string'
    || typeof value.usernameElement !== 'string'
    || typeof value.passwordElement !== 'string'
    || typeof value.encryptedPassword !== 'string'
  ) return null
  return {
    id: value.id,
    origin,
    signonRealm: value.signonRealm,
    username: value.username,
    usernameElement: value.usernameElement,
    passwordElement: value.passwordElement,
    encryptedPassword: value.encryptedPassword,
    importedAt: typeof value.importedAt === 'number' ? value.importedAt : 0,
  }
}

async function readStore(): Promise<CredentialFile> {
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(storePath(), 'utf8'))
    if (!isPlainObject(parsed) || !Array.isArray(parsed.credentials)) {
      return { version: STORE_VERSION, credentials: [] }
    }
    return {
      version: STORE_VERSION,
      credentials: parsed.credentials
        .map(normalizeStoredCredential)
        .filter((credential): credential is StoredCredential => credential !== null)
        .slice(0, MAX_CREDENTIALS),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('[browserCredentials] failed to read credential store')
    }
    return { version: STORE_VERSION, credentials: [] }
  }
}

async function writeStore(credentials: StoredCredential[]): Promise<void> {
  await writeJsonAtomic(storePath(), {
    version: STORE_VERSION,
    credentials: credentials.slice(0, MAX_CREDENTIALS),
  }, { mode: 0o600 })
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
  for (const filename of ['Login Data', 'Login Data For Account']) {
    try {
      await fsp.access(path.join(chromeRoot, directory, filename))
      return true
    } catch {
      // Try the other Chrome password store.
    }
  }
  return false
}

export async function listChromePasswordProfiles(
  chromeRoot = defaultChromeRoot(),
): Promise<BrowserCredentialProfile[]> {
  if (process.platform !== 'darwin') return []
  const state = await readLocalState(chromeRoot)
  const profile = isPlainObject(state.profile) ? state.profile : {}
  const infoCache = isPlainObject(profile.info_cache) ? profile.info_cache : {}
  const profiles: BrowserCredentialProfile[] = []

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
      'find-generic-password',
      '-w',
      '-s',
      'Chrome Safe Storage',
      '-a',
      'Chrome',
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

function credentialKey(credential: Pick<StoredCredential, 'origin' | 'signonRealm' | 'username'>): string {
  return `${credential.origin}\0${credential.signonRealm}\0${credential.username}`
}

async function storePlainCredentials(
  rows: PlainCredential[],
  skippedBeforeStore = 0,
): Promise<{ imported: number; skipped: number; total: number }> {
  assertSecureStorageAvailable()
  const current = await readStore()
  const byKey = new Map(current.credentials.map((credential) => [credentialKey(credential), credential]))
  let imported = 0
  let skipped = skippedBeforeStore

  for (const row of rows) {
    const origin = normalizeOrigin(row.origin)
    if (!origin || !row.password) {
      skipped += 1
      continue
    }
    const identity = {
      origin,
      signonRealm: row.signonRealm || origin,
      username: row.username,
    }
    const key = credentialKey(identity)
    const existing = byKey.get(key)
    byKey.set(key, {
      id: existing?.id ?? randomUUID(),
      ...identity,
      usernameElement: row.usernameElement,
      passwordElement: row.passwordElement,
      encryptedPassword: safeStorage.encryptString(row.password).toString('base64'),
      importedAt: Date.now(),
    })
    imported += 1
  }

  const credentials = [...byKey.values()]
    .sort((a, b) => b.importedAt - a.importedAt)
    .slice(0, MAX_CREDENTIALS)
  await writeStore(credentials)
  return { imported, skipped, total: credentials.length }
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

export async function importChromePasswordCsv(
  filePath: string,
): Promise<{ imported: number; skipped: number; total: number }> {
  assertSecureStorageAvailable()
  const stats = await fsp.stat(filePath)
  if (!stats.isFile() || stats.size > MAX_IMPORT_FILE_BYTES) {
    throw new Error('The selected password export is not a supported CSV file')
  }

  const rows = parseCsv(await fsp.readFile(filePath, 'utf8'))
  const header = rows.shift()?.map((column, index) =>
    (index === 0 ? column.replace(/^\uFEFF/, '') : column).trim().toLowerCase())
  if (!header) throw new Error('The selected password export is empty')

  const urlIndex = header.findIndex((column) => ['url', 'origin', 'origin_url'].includes(column))
  const usernameIndex = header.findIndex((column) => ['username', 'username_value'].includes(column))
  const passwordIndex = header.findIndex((column) => ['password', 'password_value'].includes(column))
  if (urlIndex < 0 || usernameIndex < 0 || passwordIndex < 0) {
    throw new Error('The selected file is not a Chrome password export')
  }

  const importRows: PlainCredential[] = []
  let skipped = 0
  for (const columns of rows.slice(0, MAX_CREDENTIALS)) {
    if (columns.every((column) => column === '')) continue
    const origin = normalizeOrigin(columns[urlIndex] ?? '')
    const password = columns[passwordIndex] ?? ''
    if (!origin || !password) {
      skipped += 1
      continue
    }
    importRows.push({
      origin,
      signonRealm: origin,
      username: columns[usernameIndex] ?? '',
      usernameElement: '',
      passwordElement: '',
      password,
    })
  }
  skipped += Math.max(0, rows.length - MAX_CREDENTIALS)
  return storePlainCredentials(importRows, skipped)
}

export async function importChromePasswords(
  id: string,
  options: ImportOptions = {},
): Promise<{ imported: number; skipped: number; total: number }> {
  if (process.platform !== 'darwin') {
    throw new Error('Direct Chrome profile import is unavailable; use a Chrome password export instead')
  }
  assertSecureStorageAvailable()

  const chromeRoot = options.chromeRoot ?? defaultChromeRoot()
  const directory = profileDirectoryFromId(id)
  const profiles = await listChromePasswordProfiles(chromeRoot)
  if (!directory || !profiles.some((profile) => profile.id === id)) {
    throw new Error('Chrome profile is no longer importable')
  }

  const keychainPassword = options.keychainPassword ?? await chromeSafeStoragePassword()
  const current = await readStore()
  const byKey = new Map(current.credentials.map((credential) => [credentialKey(credential), credential]))
  let imported = 0
  let skipped = 0

  for (const filename of ['Login Data', 'Login Data For Account']) {
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
      const origin = normalizeOrigin(row.origin_url)
      const password = decryptChromePassword(row.password_value, keychainPassword)
      if (!origin || password === null) {
        skipped += 1
        continue
      }

      const identity = {
        origin,
        signonRealm: row.signon_realm || origin,
        username: row.username_value || '',
      }
      const key = credentialKey(identity)
      const existing = byKey.get(key)
      byKey.set(key, {
        id: existing?.id ?? randomUUID(),
        ...identity,
        usernameElement: row.username_element || '',
        passwordElement: row.password_element || '',
        encryptedPassword: safeStorage.encryptString(password).toString('base64'),
        importedAt: Date.now(),
      })
      imported += 1
    }
  }

  const credentials = [...byKey.values()]
    .sort((a, b) => b.importedAt - a.importedAt)
    .slice(0, MAX_CREDENTIALS)
  await writeStore(credentials)
  return { imported, skipped, total: credentials.length }
}

export async function getBrowserCredentialProfiles(): Promise<BrowserCredentialProfilesResult> {
  const [profiles, store] = await Promise.all([listChromePasswordProfiles(), readStore()])
  return {
    directImportSupported: process.platform === 'darwin',
    secureStorageAvailable: secureStorageAvailable(),
    profiles,
    importedCount: store.credentials.length,
  }
}

export async function getCredentialSuggestions(url: string): Promise<BrowserCredentialSuggestion[]> {
  const origin = normalizeOrigin(url)
  if (!origin) return []
  const store = await readStore()
  return store.credentials
    .filter((credential) => credential.origin === origin)
    .map(({ id, username, origin: credentialOrigin }) => ({ id, username, origin: credentialOrigin }))
}

export async function getBrowserCredentials(): Promise<BrowserCredentialSuggestion[]> {
  const store = await readStore()
  return store.credentials.map(({ id, username, origin }) => ({ id, username, origin }))
}

export async function getCredentialForFill(
  id: string,
  url: string,
): Promise<{ username: string; password: string; usernameElement: string } | null> {
  const origin = normalizeOrigin(url)
  if (!origin) return null
  const store = await readStore()
  const credential = store.credentials.find((item) => item.id === id && item.origin === origin)
  if (!credential) return null
  try {
    return {
      username: credential.username,
      password: safeStorage.decryptString(Buffer.from(credential.encryptedPassword, 'base64')),
      usernameElement: credential.usernameElement,
    }
  } catch {
    return null
  }
}

export async function clearBrowserCredentials(): Promise<void> {
  await writeStore([])
}

export async function removeBrowserCredential(id: string): Promise<void> {
  const store = await readStore()
  await writeStore(store.credentials.filter((credential) => credential.id !== id))
}
