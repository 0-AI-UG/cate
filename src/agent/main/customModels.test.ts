import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => testUserData) },
}))

import os from 'os'
import path from 'path'
import fs from 'fs'
import fsp from 'fs/promises'
import {
  readCustomOpenAI,
  saveCustomOpenAI,
  sharedModelsPath,
  mirrorModelsToWorkspace,
} from './customModels'
import { agentDirFor } from './agentDir'

let testUserData: string

beforeEach(() => {
  testUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-models-'))
})

afterEach(() => {
  fs.rmSync(testUserData, { recursive: true, force: true })
})

describe('customModels', () => {
  it('returns null when no models.json exists', async () => {
    expect(await readCustomOpenAI()).toBeNull()
  })

  it('saves and reads back a custom provider', async () => {
    await saveCustomOpenAI({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'secret',
      models: ['llama3.1:8b', 'qwen2.5-coder:7b'],
    })
    const cfg = await readCustomOpenAI()
    expect(cfg).toEqual({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'secret',
      models: ['llama3.1:8b', 'qwen2.5-coder:7b'],
    })
  })

  it('writes pi-shaped models.json (openai-completions, models as {id})', async () => {
    await saveCustomOpenAI({ baseUrl: 'http://x/v1', apiKey: '', models: ['m1'] })
    const raw = JSON.parse(await fsp.readFile(sharedModelsPath(), 'utf-8'))
    expect(raw.providers['custom-openai']).toEqual({
      baseUrl: 'http://x/v1',
      api: 'openai-completions',
      apiKey: 'none', // placeholder when blank, since pi requires a non-empty key
      models: [{ id: 'm1' }],
    })
  })

  it('clears the provider when given null', async () => {
    await saveCustomOpenAI({ baseUrl: 'http://x/v1', apiKey: '', models: ['m1'] })
    await saveCustomOpenAI(null)
    expect(await readCustomOpenAI()).toBeNull()
  })

  it('clears the provider when no models are given', async () => {
    await saveCustomOpenAI({ baseUrl: 'http://x/v1', apiKey: '', models: ['m1'] })
    await saveCustomOpenAI({ baseUrl: 'http://x/v1', apiKey: '', models: [] })
    expect(await readCustomOpenAI()).toBeNull()
  })

  it('preserves other providers a user hand-authored in models.json', async () => {
    await fsp.mkdir(path.dirname(sharedModelsPath()), { recursive: true })
    await fsp.writeFile(
      sharedModelsPath(),
      JSON.stringify({ providers: { mine: { baseUrl: 'http://mine/v1', api: 'openai-completions', apiKey: 'k', models: [{ id: 'foo' }] } } }),
      'utf-8',
    )
    await saveCustomOpenAI({ baseUrl: 'http://x/v1', apiKey: '', models: ['m1'] })
    const raw = JSON.parse(await fsp.readFile(sharedModelsPath(), 'utf-8'))
    expect(raw.providers.mine).toBeDefined()
    expect(raw.providers['custom-openai']).toBeDefined()
  })

  it('mirrors the shared file into a workspace dir', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-ws-'))
    try {
      await saveCustomOpenAI({ baseUrl: 'http://x/v1', apiKey: '', models: ['m1'] })
      await mirrorModelsToWorkspace(cwd)
      const dest = path.join(agentDirFor(cwd), 'models.json')
      const raw = JSON.parse(await fsp.readFile(dest, 'utf-8'))
      expect(raw.providers['custom-openai'].baseUrl).toBe('http://x/v1')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('mirror is a no-op when no shared file exists (never clobbers workspace)', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-ws-'))
    try {
      await mirrorModelsToWorkspace(cwd)
      const dest = path.join(agentDirFor(cwd), 'models.json')
      expect(fs.existsSync(dest)).toBe(false)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})
