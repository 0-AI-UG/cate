import { beforeEach, describe, expect, it, vi } from 'vitest'

type JsonObject = Record<string, unknown>

const h = vi.hoisted(() => ({
  data: {} as JsonObject,
  tail: Promise.resolve() as Promise<void>,
}))

vi.mock('electron', () => ({ shell: { openExternal: vi.fn(async () => {}) } }))
vi.mock('./agentDir', () => ({ sharedAuthPath: () => '/virtual/auth.json' }))
vi.mock('./customModels', () => ({ readCustomOpenAI: vi.fn(async () => null) }))
vi.mock('@earendil-works/pi-ai', () => ({
  findEnvKeys: vi.fn(),
  getEnvApiKey: vi.fn(),
  getModels: vi.fn(() => []),
  getProviders: vi.fn(() => []),
}))
vi.mock('@earendil-works/pi-ai/oauth', () => ({
  getOAuthApiKey: vi.fn(),
  getOAuthProvider: vi.fn(),
  getOAuthProviders: vi.fn(() => []),
}))
vi.mock('./agentConfigLock', () => ({
  // Return a snapshot immediately. Code that reads outside updateAgentConfigFile
  // can therefore take the same stale snapshot in two concurrent mutations.
  readAgentConfigFile: vi.fn(async () => ({ ...h.data })),
  // Model the real per-file lock: updater callbacks execute serially and see
  // the latest committed contents.
  updateAgentConfigFile: vi.fn((_path: string, update: (current: JsonObject) => JsonObject) => {
    const run = h.tail.then(() => {
      h.data = update({ ...h.data })
    })
    h.tail = run.catch(() => {})
    return run
  }),
}))

const { AuthManager } = await import('./authManager')

beforeEach(() => {
  h.data = {}
  h.tail = Promise.resolve()
})

describe('AuthManager concurrent provider mutations', () => {
  it('preserves simultaneous API-key saves for different providers', async () => {
    const manager = new AuthManager()

    await Promise.all([
      manager.saveApiKey('openai', 'sk-openai'),
      manager.saveApiKey('anthropic', 'sk-anthropic'),
    ])

    expect(h.data).toEqual({
      openai: { type: 'api_key', key: 'sk-openai' },
      anthropic: { type: 'api_key', key: 'sk-anthropic' },
    })
  })

  it('does not resurrect a deleted provider while another provider is saved', async () => {
    h.data = {
      anthropic: { type: 'api_key', key: 'old-anthropic' },
      google: { type: 'api_key', key: 'old-google' },
    }
    const manager = new AuthManager()

    await Promise.all([
      manager.deleteProvider('anthropic'),
      manager.saveApiKey('openai', 'sk-openai'),
    ])

    expect(h.data).toEqual({
      google: { type: 'api_key', key: 'old-google' },
      openai: { type: 'api_key', key: 'sk-openai' },
    })
  })
})
