// Tests for AuthManager.verify — the "is this credential usable?" check.
// OAuth is actively refreshed (that's legitimately main's job); API-key / env /
// custom providers are reported by presence (no model inference runs in main).
// pi-ai and the auth.json path are mocked; a real temp file backs auth.json so
// OAuth token write-back is exercised.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'

const h = vi.hoisted(() => ({
  authJsonPath: '',
  userData: '',
  oauthProviders: [{ id: 'anthropic', name: 'Anthropic', usesCallbackServer: true }] as Array<{
    id: string
    name: string
    usesCallbackServer?: boolean
  }>,
  getOAuthApiKey: vi.fn(),
  getModels: vi.fn(),
  findEnvKeys: vi.fn(),
  readCustomOpenAI: vi.fn(),
}))

vi.mock('electron', () => ({ app: { getPath: () => h.userData }, shell: {} }))
vi.mock('./agentDir', () => ({ sharedAuthPath: () => h.authJsonPath }))
vi.mock('./agentConfigLock', () => ({
  agentConfigLock: { run: (_key: string, fn: () => Promise<void>) => fn() },
}))
vi.mock('./customModels', () => ({ readCustomOpenAI: () => h.readCustomOpenAI() }))
vi.mock('@earendil-works/pi-ai', () => ({
  findEnvKeys: (...args: unknown[]) => h.findEnvKeys(...args),
  getModels: (...args: unknown[]) => h.getModels(...args),
}))
vi.mock('@earendil-works/pi-ai/oauth', () => ({
  getOAuthApiKey: (...args: unknown[]) => h.getOAuthApiKey(...args),
  getOAuthProvider: vi.fn(),
  getOAuthProviders: () => h.oauthProviders,
}))

import { authManager } from './authManager'

function seedAuth(data: Record<string, unknown>): void {
  fs.writeFileSync(h.authJsonPath, JSON.stringify(data), 'utf-8')
}
function readAuth(): Record<string, { type: string; access?: string; expires?: number; key?: string }> {
  return JSON.parse(fs.readFileSync(h.authJsonPath, 'utf-8'))
}

beforeEach(() => {
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-auth-'))
  h.authJsonPath = path.join(h.userData, 'auth.json')
  seedAuth({})
  h.getOAuthApiKey.mockReset()
  h.getModels.mockReset()
  h.findEnvKeys.mockReset().mockReturnValue(undefined)
  h.readCustomOpenAI.mockReset().mockResolvedValue(null)
})

afterEach(() => {
  fs.rmSync(h.userData, { recursive: true, force: true })
})

describe('AuthManager.verify — OAuth', () => {
  it('returns ok and persists a refreshed token', async () => {
    seedAuth({ anthropic: { type: 'oauth', access: 'old', refresh: 'r', expires: 1 } })
    h.getOAuthApiKey.mockResolvedValue({
      apiKey: 'sk-live',
      newCredentials: { access: 'new', refresh: 'r', expires: 9999 },
    })

    const res = await authManager.verify('anthropic')

    expect(res).toEqual({ id: 'anthropic', health: 'ok' })
    // The refreshed credential was written back to auth.json.
    expect(readAuth().anthropic).toMatchObject({ type: 'oauth', access: 'new', expires: 9999 })
  })

  it('does not rewrite auth.json when the token is unchanged', async () => {
    seedAuth({ anthropic: { type: 'oauth', access: 'same', refresh: 'r', expires: 5 } })
    h.getOAuthApiKey.mockResolvedValue({
      apiKey: 'sk-live',
      newCredentials: { access: 'same', refresh: 'r', expires: 5 },
    })

    const res = await authManager.verify('anthropic')
    expect(res.health).toBe('ok')
    expect(readAuth().anthropic).toMatchObject({ access: 'same', expires: 5 })
  })

  it('returns needsReauth when refresh throws', async () => {
    seedAuth({ anthropic: { type: 'oauth', access: 'old', refresh: 'r', expires: 1 } })
    h.getOAuthApiKey.mockRejectedValue(new Error('refresh_token expired'))

    const res = await authManager.verify('anthropic')
    expect(res).toMatchObject({ id: 'anthropic', health: 'needsReauth', error: 'refresh_token expired' })
  })

  it('returns needsReauth when there is no oauth credential', async () => {
    const res = await authManager.verify('anthropic')
    expect(res).toEqual({ id: 'anthropic', health: 'needsReauth' })
  })
})

describe('AuthManager.verify — API key (presence only, no inference in main)', () => {
  it('is ok when a stored api key is present', async () => {
    seedAuth({ openai: { type: 'api_key', key: 'sk-test' } })
    const res = await authManager.verify('openai')
    expect(res).toEqual({ id: 'openai', health: 'ok' })
  })

  it('is ok when the credential comes from an env var', async () => {
    h.findEnvKeys.mockReturnValue(['OPENAI_API_KEY'])
    const res = await authManager.verify('openai')
    expect(res).toEqual({ id: 'openai', health: 'ok' })
  })

  it('is error when there is no credential at all', async () => {
    const res = await authManager.verify('openai')
    expect(res).toMatchObject({ id: 'openai', health: 'error' })
  })
})

describe('AuthManager.verify — custom-openai', () => {
  it('is ok when a baseUrl and models are configured', async () => {
    h.readCustomOpenAI.mockResolvedValue({ baseUrl: 'http://localhost:11434/v1', apiKey: '', models: ['llama3'] })
    const res = await authManager.verify('custom-openai')
    expect(res).toEqual({ id: 'custom-openai', health: 'ok' })
  })

  it('is error when not configured', async () => {
    h.readCustomOpenAI.mockResolvedValue(null)
    const res = await authManager.verify('custom-openai')
    expect(res).toEqual({ id: 'custom-openai', health: 'error' })
  })
})
