import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chat } from '../../shared/types'
import { useCodingStore } from './codingStore'
import {
  directAgentKey,
  promptDirectChat,
} from './directChatSession'

const chat: Chat = {
  id: 'chat-1',
  title: 'New chat',
  createdAt: 1,
  updatedAt: 1,
  model: { provider: 'test-provider', model: 'test-model' },
}

beforeEach(() => {
  vi.clearAllMocks()
  useCodingStore.setState({ panels: {} })
  ;(globalThis as unknown as { window: unknown }).window = {
    electronAPI: {
      agentCreate: vi.fn(async () => ({ ok: true })),
      agentPrompt: vi.fn(async () => {}),
    },
  }
})

describe('promptDirectChat', () => {
  it('appends a new chat’s first message before asynchronous session startup', async () => {
    const sending = promptDirectChat(chat, 'workspace-1', '/repo', 'First message')
    const agentKey = directAgentKey(chat.id)

    expect(useCodingStore.getState().panels[agentKey]?.messages).toMatchObject([
      { type: 'user', text: 'First message' },
    ])
    await expect(sending).resolves.toBe(true)
  })
})
