// The loop model is now per-chat with a global-default fallback (there is no
// separate cateAgentModel setting). createCateAgentSession resolves the model it
// hands pi as: the chat's own `opts.model` if set, else loadDefaultModel(), else
// undefined (pi picks its own first-available). These pin that resolution.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CateAgentModelRef } from '../../shared/types'

const create = vi.fn().mockResolvedValue({ ok: true })
vi.mock('./codingClient', () => ({
  codingClient: { create: (opts: unknown) => create(opts) },
}))

const loadDefaultModel = vi.fn((): CateAgentModelRef | null => null)
vi.mock('./codingModelPrefs', () => ({
  loadDefaultModel: () => loadDefaultModel(),
}))

vi.mock('../../renderer/lib/logger', () => ({ default: { warn: vi.fn() } }))

import { createCateAgentSession } from './cateAgentSession'

const BASE = { panelId: 'cate-agent-orchestrator:c1', rootPath: '/repo', workspaceId: 'ws-1', role: 'orchestrator' as const }

beforeEach(() => {
  create.mockClear()
  loadDefaultModel.mockReturnValue(null)
})

describe('createCateAgentSession model resolution', () => {
  it('uses the chat model when set, overriding the default', async () => {
    loadDefaultModel.mockReturnValue({ provider: 'openai', model: 'gpt-x' })
    const chatModel = { provider: 'anthropic', model: 'claude-x' }
    await createCateAgentSession({ ...BASE, model: chatModel })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: chatModel }))
  })

  it('falls back to the global default when the chat has no model', async () => {
    loadDefaultModel.mockReturnValue({ provider: 'openai', model: 'gpt-x' })
    await createCateAgentSession({ ...BASE })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: { provider: 'openai', model: 'gpt-x' } }))
  })

  it('passes undefined when neither a chat model nor a default is set', async () => {
    await createCateAgentSession({ ...BASE })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: undefined }))
  })
})
