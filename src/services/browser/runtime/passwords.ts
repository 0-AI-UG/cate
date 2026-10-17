// Saved passwords: the `browserPasswords` field of the workspace's
// secrets.json (0600). No keychain: protection is the machine user's file
// permissions (7.2). Passwords reach a client only through `passwordForFill`.

import { randomUUID } from 'node:crypto'
import { isPlainObject } from '@kernel/state/contract'
import type { JsonStateFile } from '@kernel/state/node'
import type { SecretsFile } from '@runtime/data/runtime'
import {
  credentialOrigin,
  type BrowserCredentialFill,
  type BrowserCredentialImport,
  type BrowserCredentialImportResult,
  type BrowserCredentialSaveDisposition,
  type BrowserCredentialSaveInput,
  type BrowserCredentialSaveResult,
  type BrowserCredentialSuggestion,
} from '../contract'

export const PASSWORDS_KEY = 'browserPasswords'

const MAX_CREDENTIALS = 20_000
const MAX_ORIGIN_LENGTH = 2_048
const MAX_USERNAME_LENGTH = 1_024
const MAX_PASSWORD_LENGTH = 16 * 1024
const MAX_ELEMENT_NAME_LENGTH = 256

interface StoredCredential {
  id: string
  origin: string
  signonRealm: string
  username: string
  usernameElement: string
  passwordElement: string
  password: string
  savedAt: number
}

function normalizeStored(value: unknown): StoredCredential | null {
  if (!isPlainObject(value)) return null
  const origin = typeof value.origin === 'string' ? credentialOrigin(value.origin) : null
  if (
    !origin
    || typeof value.id !== 'string'
    || typeof value.username !== 'string'
    || typeof value.password !== 'string'
    || !value.password
  ) return null
  return {
    id: value.id,
    origin,
    signonRealm: typeof value.signonRealm === 'string' ? value.signonRealm : origin,
    username: value.username,
    usernameElement: typeof value.usernameElement === 'string' ? value.usernameElement : '',
    passwordElement: typeof value.passwordElement === 'string' ? value.passwordElement : '',
    password: value.password,
    savedAt: typeof value.savedAt === 'number' ? value.savedAt : 0,
  }
}

function validateInput(input: BrowserCredentialSaveInput) {
  const origin = typeof input.origin === 'string' && input.origin.length <= MAX_ORIGIN_LENGTH
    ? credentialOrigin(input.origin)
    : null
  if (
    !origin
    || typeof input.password !== 'string'
    || !input.password
    || typeof input.username !== 'string'
    || input.username.length > MAX_USERNAME_LENGTH
    || input.password.length > MAX_PASSWORD_LENGTH
    || (input.usernameElement?.length ?? 0) > MAX_ELEMENT_NAME_LENGTH
    || (input.passwordElement?.length ?? 0) > MAX_ELEMENT_NAME_LENGTH
  ) {
    throw new Error('The password entry is invalid')
  }
  return {
    origin,
    username: input.username,
    password: input.password,
    usernameElement: input.usernameElement ?? '',
    passwordElement: input.passwordElement ?? '',
  }
}

const suggestion = ({ id, username, origin }: StoredCredential): BrowserCredentialSuggestion => ({ id, username, origin })
const credentialKey = (c: Pick<StoredCredential, 'origin' | 'signonRealm' | 'username'>) =>
  `${c.origin}\0${c.signonRealm}\0${c.username}`

export interface PasswordStore {
  list(): BrowserCredentialSuggestion[]
  suggestions(url: string): BrowserCredentialSuggestion[]
  saveDisposition(input: BrowserCredentialSaveInput): BrowserCredentialSaveDisposition
  save(input: BrowserCredentialSaveInput): Promise<BrowserCredentialSaveResult>
  import(rows: BrowserCredentialImport[]): Promise<BrowserCredentialImportResult>
  forFill(id: string, url: string): BrowserCredentialFill | null
  remove(id: string): Promise<void>
  clear(): Promise<void>
}

export function createPasswordStore(
  secrets: JsonStateFile<SecretsFile>,
  opts: { now?: () => number; newId?: () => string } = {},
): PasswordStore {
  const now = opts.now ?? Date.now
  const newId = opts.newId ?? randomUUID

  const read = (): StoredCredential[] => {
    const raw = secrets.get()[PASSWORDS_KEY]
    if (!Array.isArray(raw)) return []
    return raw.map(normalizeStored).filter((c): c is StoredCredential => c !== null).slice(0, MAX_CREDENTIALS)
  }
  const write = async (credentials: StoredCredential[]): Promise<void> => {
    secrets.update((cur) => ({ ...cur, [PASSWORDS_KEY]: credentials.slice(0, MAX_CREDENTIALS) }))
    await secrets.flushDurable()
  }
  const findSame = (list: StoredCredential[], origin: string, username: string) =>
    list.find((c) => c.origin === origin && c.username === username)

  return {
    list: () => read().map(suggestion),
    suggestions(url) {
      const origin = credentialOrigin(url)
      if (!origin) return []
      return read().filter((c) => c.origin === origin).map(suggestion)
    },
    saveDisposition(input) {
      const value = validateInput(input)
      const existing = findSame(read(), value.origin, value.username)
      if (!existing) return 'create'
      return existing.password === value.password ? 'unchanged' : 'update'
    },
    async save(input) {
      const value = validateInput(input)
      const current = read()
      const existing = findSame(current, value.origin, value.username)
      if (existing && existing.password === value.password) {
        return { action: 'unchanged', credential: suggestion(existing) }
      }
      const stored: StoredCredential = {
        id: existing?.id ?? newId(),
        origin: value.origin,
        signonRealm: value.origin,
        username: value.username,
        usernameElement: value.usernameElement,
        passwordElement: value.passwordElement,
        password: value.password,
        savedAt: now(),
      }
      await write([stored, ...current.filter((c) => c.id !== stored.id)])
      return { action: existing ? 'updated' : 'created', credential: suggestion(stored) }
    },
    async import(rows) {
      const byKey = new Map(read().map((c) => [credentialKey(c), c]))
      let imported = 0
      let skipped = 0
      for (const row of rows.slice(0, MAX_CREDENTIALS)) {
        const origin = typeof row?.origin === 'string' ? credentialOrigin(row.origin) : null
        if (!origin || typeof row.password !== 'string' || !row.password || typeof row.username !== 'string') {
          skipped += 1
          continue
        }
        const identity = { origin, signonRealm: row.signonRealm || origin, username: row.username }
        const key = credentialKey(identity)
        byKey.set(key, {
          id: byKey.get(key)?.id ?? newId(),
          ...identity,
          usernameElement: row.usernameElement ?? '',
          passwordElement: row.passwordElement ?? '',
          password: row.password,
          savedAt: now(),
        })
        imported += 1
      }
      skipped += Math.max(0, rows.length - MAX_CREDENTIALS)
      const credentials = [...byKey.values()].sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_CREDENTIALS)
      await write(credentials)
      return { imported, skipped, total: credentials.length }
    },
    forFill(id, url) {
      const origin = credentialOrigin(url)
      if (!origin) return null
      const credential = read().find((c) => c.id === id && c.origin === origin)
      return credential
        ? { username: credential.username, password: credential.password, usernameElement: credential.usernameElement }
        : null
    },
    remove: (id) => write(read().filter((c) => c.id !== id)),
    clear: () => write([]),
  }
}
