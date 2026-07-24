import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => testUserData) },
}))

import os from 'os'
import path from 'path'
import fs from 'fs'
import fsp from 'fs/promises'
import {
  deleteCustomOpenAIProvider,
  readCustomOpenAIProviders,
  saveCustomOpenAIProvider,
  sharedModelsPath,
  mirrorModelsToWorkspace,
} from './customModels'
import { agentDirFor } from './agentDir'
import type { Runtime } from '../../main/runtime/types'

// A minimal local runtime: hostAgentDir uses 'local' (native paths) and the
// file ops go straight to real fs — exactly what mirrorModelsToWorkspace needs.
const fakeRuntime = {
  id: 'local',
  file: {
    mkdir: (p: string) => fsp.mkdir(p, { recursive: true }),
    writeFile: (p: string, c: string) => fsp.writeFile(p, c, 'utf-8'),
  },
} as unknown as Runtime

let testUserData: string

beforeEach(() => {
  testUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-models-'))
})

afterEach(() => {
  fs.rmSync(testUserData, { recursive: true, force: true })
})

describe('customModels', () => {
  it('returns an empty list when no models.json exists', async () => {
    expect(await readCustomOpenAIProviders()).toEqual([])
  })

  it('saves and reads back multiple managed providers', async () => {
    await saveCustomOpenAIProvider({
      id: 'custom-openai-ollama',
      name: 'Local Ollama',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'secret',
      models: ['llama3.1:8b'],
    })
    await saveCustomOpenAIProvider({
      id: 'custom-openai-proxy',
      name: 'Team Proxy',
      baseUrl: 'https://proxy.example/v1',
      apiKey: 'proxy-secret',
      models: ['qwen2.5-coder:7b'],
    })

    expect(await readCustomOpenAIProviders()).toEqual([
      {
        id: 'custom-openai-ollama',
        name: 'Local Ollama',
        baseUrl: 'http://localhost:11434/v1',
        apiKey: 'secret',
        models: ['llama3.1:8b'],
      },
      {
        id: 'custom-openai-proxy',
        name: 'Team Proxy',
        baseUrl: 'https://proxy.example/v1',
        apiKey: 'proxy-secret',
        models: ['qwen2.5-coder:7b'],
      },
    ])
  })

  it('writes pi-shaped models.json (openai-completions, models as {id})', async () => {
    await saveCustomOpenAIProvider({
      id: 'custom-openai-local',
      name: 'Local',
      baseUrl: 'http://x/v1',
      apiKey: '',
      models: ['m1'],
    })
    const raw = JSON.parse(await fsp.readFile(sharedModelsPath(), 'utf-8'))
    expect(raw.providers['custom-openai-local']).toEqual({
      name: 'Local',
      baseUrl: 'http://x/v1',
      api: 'openai-completions',
      apiKey: 'none', // placeholder when blank, since pi requires a non-empty key
      models: [{ id: 'm1' }],
    })
  })

  it('updates and deletes one provider without changing managed siblings or unmanaged data', async () => {
    await fsp.mkdir(path.dirname(sharedModelsPath()), { recursive: true })
    await fsp.writeFile(
      sharedModelsPath(),
      JSON.stringify({
        providers: {
          mine: {
            baseUrl: 'http://mine/v1',
            api: 'openai-completions',
            apiKey: 'k',
            headers: { 'X-Unmanaged': 'keep' },
            models: [{ id: 'foo', contextWindow: 1234 }],
          },
          'custom-openai-one': {
            name: 'One',
            baseUrl: 'http://old/v1',
            api: 'openai-completions',
            apiKey: 'old',
            headers: { 'X-Managed-Advanced': 'keep' },
            models: [{ id: 'm1', contextWindow: 8192 }],
          },
          'custom-openai-two': {
            name: 'Two',
            baseUrl: 'http://two/v1',
            api: 'openai-completions',
            apiKey: 'two',
            models: [{ id: 'm2' }],
          },
        },
      }),
      'utf-8',
    )

    await saveCustomOpenAIProvider({
      id: 'custom-openai-one',
      name: 'One updated',
      baseUrl: 'http://new/v1',
      apiKey: 'new',
      models: ['m1', 'm3'],
    })
    await deleteCustomOpenAIProvider('custom-openai-two')

    const raw = JSON.parse(await fsp.readFile(sharedModelsPath(), 'utf-8'))
    expect(raw.providers.mine).toEqual({
      baseUrl: 'http://mine/v1',
      api: 'openai-completions',
      apiKey: 'k',
      headers: { 'X-Unmanaged': 'keep' },
      models: [{ id: 'foo', contextWindow: 1234 }],
    })
    expect(raw.providers['custom-openai-one']).toMatchObject({
      name: 'One updated',
      baseUrl: 'http://new/v1',
      apiKey: 'new',
      headers: { 'X-Managed-Advanced': 'keep' },
      models: [{ id: 'm1', contextWindow: 8192 }, { id: 'm3' }],
    })
    expect(raw.providers['custom-openai-two']).toBeUndefined()
  })

  it('loads the legacy custom-openai provider without changing its id', async () => {
    await fsp.mkdir(path.dirname(sharedModelsPath()), { recursive: true })
    await fsp.writeFile(
      sharedModelsPath(),
      JSON.stringify({
        providers: {
          'custom-openai': {
            baseUrl: 'http://legacy/v1',
            api: 'openai-completions',
            apiKey: 'legacy-key',
            models: [{ id: 'legacy-model' }],
          },
          mine: {
            name: 'Hand-authored',
            baseUrl: 'http://mine/v1',
            api: 'openai-completions',
            apiKey: 'mine',
            models: [{ id: 'mine-model' }],
          },
        },
      }),
      'utf-8',
    )

    expect(await readCustomOpenAIProviders()).toEqual([{
      id: 'custom-openai',
      name: 'Custom OpenAI endpoint',
      baseUrl: 'http://legacy/v1',
      apiKey: 'legacy-key',
      models: ['legacy-model'],
    }])
  })

  it('mirrors the shared file into a workspace dir', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-ws-'))
    try {
      await saveCustomOpenAIProvider({
        id: 'custom-openai-local',
        name: 'Local',
        baseUrl: 'http://x/v1',
        apiKey: '',
        models: ['m1'],
      })
      await mirrorModelsToWorkspace(fakeRuntime, cwd)
      const dest = path.join(agentDirFor(cwd), 'models.json')
      const raw = JSON.parse(await fsp.readFile(dest, 'utf-8'))
      expect(raw.providers['custom-openai-local'].baseUrl).toBe('http://x/v1')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('mirror is a no-op when no shared file exists (never clobbers workspace)', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-ws-'))
    try {
      await mirrorModelsToWorkspace(fakeRuntime, cwd)
      const dest = path.join(agentDirFor(cwd), 'models.json')
      expect(fs.existsSync(dest)).toBe(false)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})
