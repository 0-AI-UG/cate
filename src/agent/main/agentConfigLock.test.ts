import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { readAgentConfigFile, updateAgentConfigFile } from './agentConfigLock'

let dir: string
let file: string

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cate-agent-config-'))
  file = path.join(dir, 'auth.json')
})

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('shared agent config access', () => {
  it('returns null for missing, corrupt, and non-object files', async () => {
    await expect(readAgentConfigFile(file)).resolves.toBeNull()
    await fsp.writeFile(file, '{broken')
    await expect(readAgentConfigFile(file)).resolves.toBeNull()
    await fsp.writeFile(file, '[]')
    await expect(readAgentConfigFile(file)).resolves.toBeNull()
  })

  it('preserves existing keys and writes private file permissions', async () => {
    await fsp.writeFile(file, JSON.stringify({ external: true }))

    await updateAgentConfigFile(file, (current) => ({ ...current, owned: 'value' }))

    await expect(readAgentConfigFile(file)).resolves.toEqual({ external: true, owned: 'value' })
    expect((await fsp.stat(file)).mode & 0o777).toBe(0o600)
  })

  it('serializes concurrent read-modify-write updates without losing data', async () => {
    await Promise.all(
      Array.from({ length: 12 }, () =>
        updateAgentConfigFile(file, (current) => ({
          ...current,
          count: typeof current.count === 'number' ? current.count + 1 : 1,
        })),
      ),
    )

    await expect(readAgentConfigFile(file)).resolves.toMatchObject({ count: 12 })
  })
})
