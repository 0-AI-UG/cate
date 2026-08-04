import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ dir: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => state.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ''),
  },
}))
vi.mock('../logger', () => ({ default: { warn: vi.fn() } }))

import { getSshSecret, saveSshSecret } from './sshSecretStore'

beforeEach(async () => {
  state.dir = await mkdtemp(join(tmpdir(), 'cate-ssh-secrets-'))
})

afterEach(async () => {
  await rm(state.dir, { recursive: true, force: true })
})

describe('sshSecretStore', () => {
  test('round-trips an explicitly disabled agent alongside encrypted key auth', async () => {
    await saveSshSecret('srv_test', {
      keyPath: '/keys/id_ecdsa',
      passphrase: 'secret',
      useAgent: false,
    })

    expect(await getSshSecret('srv_test')).toEqual({
      keyPath: '/keys/id_ecdsa',
      passphrase: 'secret',
      useAgent: false,
    })
    const disk = JSON.parse(await readFile(join(state.dir, 'runtime-ssh-secrets.json'), 'utf8'))
    expect(disk.srv_test.useAgent).toBe(false)
    expect(disk.srv_test.passphrase).not.toBe('secret')
  })
})
