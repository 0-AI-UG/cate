import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openSecretsFile, type SecretsFile } from '@runtime/data/runtime'
import type { JsonStateFile } from '@kernel/state/node'
import { createPasswordStore, PASSWORDS_KEY, type PasswordStore } from './passwords'

let dir: string
let secrets: JsonStateFile<SecretsFile>
let store: PasswordStore
let ids = 0

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-passwords-'))
  ids = 0
  secrets = openSecretsFile(dir)
  secrets.load()
  store = createPasswordStore(secrets, { newId: () => `id-${++ids}` })
})
afterEach(async () => {
  secrets.dispose()
  await fs.rm(dir, { recursive: true, force: true })
})

describe('saved passwords', () => {
  it('stores passwords in secrets.json with mode 0600, next to other secrets', async () => {
    secrets.update((cur) => ({ ...cur, runtimeKey: { publicKey: 'p', secretKey: 's' } as never }))
    await store.save({ origin: 'https://example.com/login', username: 'me', password: 'hunter2' })
    const file = path.join(dir, 'secrets.json')
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(onDisk.runtimeKey).toBeTruthy()
    expect(onDisk[PASSWORDS_KEY]).toHaveLength(1)
    expect(onDisk[PASSWORDS_KEY][0]).toMatchObject({ origin: 'https://example.com', username: 'me', password: 'hunter2' })
  })

  it('creates, updates, and deduplicates credentials', async () => {
    const input = {
      origin: 'https://example.com/login',
      username: 'person@example.com',
      password: 'first secret',
      usernameElement: 'email',
      passwordElement: 'password',
    }
    expect(store.saveDisposition(input)).toBe('create')
    const created = await store.save(input)
    expect(created.action).toBe('created')
    expect(store.saveDisposition(input)).toBe('unchanged')
    await expect(store.save(input)).resolves.toMatchObject({ action: 'unchanged', credential: { id: created.credential.id } })

    const changed = { ...input, password: 'replacement secret' }
    expect(store.saveDisposition(changed)).toBe('update')
    await expect(store.save(changed)).resolves.toMatchObject({ action: 'updated', credential: { id: created.credential.id } })
    expect(store.list()).toHaveLength(1)
    expect(store.forFill(created.credential.id, 'https://example.com/account')).toEqual({
      username: 'person@example.com',
      password: 'replacement secret',
      usernameElement: 'email',
    })
  })

  it('exposes only matching usernames, never passwords, in suggestions', async () => {
    await store.save({ origin: 'https://example.com', username: 'me', password: 'secret' })
    const suggestions = store.suggestions('https://example.com/account')
    expect(suggestions).toEqual([{ id: 'id-1', username: 'me', origin: 'https://example.com' }])
    expect(store.suggestions('https://lookalike.example/account')).toEqual([])
    expect(store.forFill('id-1', 'https://lookalike.example')).toBeNull()
  })

  it('rejects invalid entries', async () => {
    await expect(store.save({ origin: 'javascript:alert(1)', username: 'a', password: 'secret' })).rejects.toThrow('invalid')
    await expect(store.save({ origin: 'https://example.com', username: '', password: '' })).rejects.toThrow('invalid')
  })

  it('imports rows, skipping unusable ones and merging by identity', async () => {
    const result = await store.import([
      { origin: 'https://example.com/login', username: 'a', password: 'one' },
      { origin: 'ftp://example.com', username: 'b', password: 'two' },
      { origin: 'https://example.com', username: 'a', password: 'three' },
    ])
    expect(result).toEqual({ imported: 2, skipped: 1, total: 1 })
    expect(store.forFill(store.list()[0].id, 'https://example.com')?.password).toBe('three')
  })

  it('keeps credentials saved concurrently', async () => {
    await Promise.all([
      store.save({ origin: 'https://one.example/login', username: 'one', password: 'secret-one' }),
      store.save({ origin: 'https://two.example/login', username: 'two', password: 'secret-two' }),
    ])
    expect(store.list().map((row) => row.username).sort()).toEqual(['one', 'two'])
  })

  it('removes and clears', async () => {
    const { credential } = await store.save({ origin: 'https://a.example', username: 'a', password: 'x' })
    await store.save({ origin: 'https://b.example', username: 'b', password: 'y' })
    await store.remove(credential.id)
    expect(store.list().map((c) => c.username)).toEqual(['b'])
    await store.clear()
    expect(store.list()).toEqual([])
  })
})
