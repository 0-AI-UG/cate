import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chat } from '../../shared/types'
import { useChatsStore } from '../../renderer/stores/chatsStore'
import { useCateAgentStore } from './cateAgentStore'
import { promptDirectChat } from './directChatSession'
import { sendDirectAgentMessage } from './cateAgentSend'

vi.mock('./directChatSession', () => ({
  promptDirectChat: vi.fn(),
}))

const ROOT = '/repo'
const WS_ID = 'workspace-1'

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as unknown as { window: unknown }).window = {
    electronAPI: {
      projectChatsSave: vi.fn(),
      projectChatsLoad: vi.fn(async () => [] as Chat[]),
    },
  }
  useChatsStore.setState({
    chatsByRoot: { [ROOT]: [] },
    loadedRoots: { [ROOT]: true },
  })
  useCateAgentStore.setState({ byWs: {} })
})

describe('sendDirectAgentMessage', () => {
  it('creates and selects a sidebar chat for the first message', () => {
    const chatId = sendDirectAgentMessage(WS_ID, ROOT, 'Start here')
    const chat = useChatsStore.getState().getChat(ROOT, chatId)

    expect(chat).toMatchObject({ id: chatId, title: 'Start here' })
    expect(useCateAgentStore.getState().byWs[WS_ID]?.activeChatId).toBe(chatId)
    expect(promptDirectChat).toHaveBeenCalledWith(chat, WS_ID, ROOT, 'Start here', undefined, undefined)
  })

  it('creates the first message in the requesting agent panel', () => {
    const chatId = sendDirectAgentMessage(
      WS_ID,
      ROOT,
      'Panel task',
      undefined,
      undefined,
      undefined,
      'agent-panel-1',
    )
    const chat = useChatsStore.getState().getChat(ROOT, chatId)

    expect(chat?.hostPanelId).toBe('agent-panel-1')
    expect(promptDirectChat).toHaveBeenCalledWith(chat, WS_ID, ROOT, 'Panel task', undefined, undefined)
  })
})
