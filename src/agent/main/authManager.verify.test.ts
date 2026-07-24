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
  getProviders: vi.fn(),
  findEnvKeys: vi.fn(),
  readCustomOpenAIProviders: vi.fn(),
}))

vi.mock('electron', () => ({ app: { getPath: () => h.userData }, shell: {} }))
vi.mock('./agentDir', () => ({ sharedAuthPath: () => h.authJsonPath }))
vi.mock('./customModels', () => ({
  readCustomOpenAIProviders: () => h.readCustomOpenAIProviders(),
}))
vi.mock('@earendil-works/pi-ai/compat', () => ({
  findEnvKeys: (...args: unknown[]) => h.findEnvKeys(...args),
  getEnvApiKey: () => undefined,
}))
vi.mock('@earendil-works/pi-ai/providers/all', () => ({
  getBuiltinModels: (...args: unknown[]) => h.getModels(...args),
  getBuiltinProviders: () => h.getProviders(),
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
  // pi's live catalog: curated ids plus entries the picker must NOT offer
  // (non-API-key auth, OAuth-only, regional variants).
  h.getProviders.mockReset().mockReturnValue([
    'amazon-bedrock', 'anthropic', 'azure-openai-responses', 'cerebras',
    'cloudflare-ai-gateway', 'cloudflare-workers-ai', 'deepseek', 'fireworks',
    'github-copilot', 'google', 'google-vertex', 'groq', 'huggingface',
    'kimi-coding', 'minimax', 'minimax-cn', 'mistral', 'moonshotai',
    'moonshotai-cn', 'openai', 'openai-codex', 'opencode', 'opencode-go',
    'openrouter', 'together', 'vercel-ai-gateway', 'xai', 'xiaomi',
    'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp', 'zai',
  ])
  h.findEnvKeys.mockReset().mockReturnValue(undefined)
  h.readCustomOpenAIProviders.mockReset().mockResolvedValue([])
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

describe('AuthManager.listProviders — curated API-key catalog', () => {
  it('offers OAuth providers plus the curated allow-list in order, OpenAI first', async () => {
    const providers = await authManager.listProviders()
    const apiKeyIds = providers.filter((p) => p.kind === 'apiKey').map((p) => p.id)

    expect(providers[0]).toMatchObject({ id: 'anthropic', kind: 'oauth' })
    expect(apiKeyIds).toEqual([
      'openai', 'anthropic', 'openrouter', 'google', 'groq', 'xai', 'mistral',
      'deepseek', 'moonshotai', 'zai', 'minimax', 'cerebras', 'together',
      'fireworks', 'huggingface', 'cloudflare-workers-ai', 'vercel-ai-gateway',
    ])
    // Not offered: bare API keys can't authenticate these / OAuth-only /
    // regional variants — even though pi's catalog contains them.
    for (const id of ['azure-openai-responses', 'google-vertex', 'cloudflare-ai-gateway', 'github-copilot', 'amazon-bedrock', 'openai-codex', 'moonshotai-cn', 'xiaomi-token-plan-cn']) {
      expect(apiKeyIds).not.toContain(id)
    }
  })

  it('drops curated ids pi no longer knows (intersection with getProviders)', async () => {
    h.getProviders.mockReturnValue(['openai', 'groq'])
    const providers = await authManager.listProviders()
    const apiKeyIds = providers.filter((p) => p.kind === 'apiKey').map((p) => p.id)
    expect(apiKeyIds).toEqual(['openai', 'groq'])
  })
})

describe('AuthManager — custom OpenAI providers', () => {
  it('reports status and selectable models for every configured provider', async () => {
    h.readCustomOpenAIProviders.mockResolvedValue([
      {
        id: 'custom-openai',
        name: 'Legacy',
        baseUrl: 'http://legacy/v1',
        apiKey: '',
        models: ['legacy-model'],
      },
      {
        id: 'custom-openai-team',
        name: 'Team Proxy',
        baseUrl: 'https://team.example/v1',
        apiKey: 'secret',
        models: ['team-a', 'team-b'],
      },
    ])

    expect(await authManager.status()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'custom-openai', connected: true }),
      expect.objectContaining({ id: 'custom-openai-team', connected: true }),
    ]))
    expect(await authManager.listAvailableModels()).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'custom-openai', id: 'legacy-model' }),
      expect.objectContaining({ provider: 'custom-openai-team', id: 'team-a' }),
      expect.objectContaining({ provider: 'custom-openai-team', id: 'team-b' }),
    ]))
  })

  it('verifies each managed provider independently', async () => {
    h.readCustomOpenAIProviders.mockResolvedValue([
      {
        id: 'custom-openai-team',
        name: 'Team Proxy',
        baseUrl: 'https://team.example/v1',
        apiKey: 'secret',
        models: ['team-model'],
      },
    ])

    expect(await authManager.verify('custom-openai-team')).toEqual({
      id: 'custom-openai-team',
      health: 'ok',
    })
    expect(await authManager.verify('custom-openai-missing')).toEqual({
      id: 'custom-openai-missing',
      health: 'error',
    })
  })

  it('reports an incomplete provider as disconnected', async () => {
    h.readCustomOpenAIProviders.mockResolvedValue([{
      id: 'custom-openai',
      name: 'Legacy',
      baseUrl: '',
      apiKey: '',
      models: [],
    }])

    expect(await authManager.verify('custom-openai')).toEqual({
      id: 'custom-openai',
      health: 'error',
    })
  })
})
