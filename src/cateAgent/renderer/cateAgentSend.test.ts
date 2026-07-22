import { describe, expect, it, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  getChat: vi.fn(),
  createChat: vi.fn(),
  setActiveChat: vi.fn(),
  sendMessage: vi.fn(),
  promptDirectChat: vi.fn(),
  wsState: { observerView: false, activeChatId: '' } as { observerView: boolean; activeChatId: string },
}))

vi.mock('../../renderer/stores/chatsStore', () => ({
  useChatsStore: { getState: () => ({ getChat: h.getChat, createChat: h.createChat }) },
}))
vi.mock('./cateAgentStore', () => ({
  useCateAgentStore: {
    getState: () => ({ byWs: { ws1: h.wsState }, setActiveChat: h.setActiveChat }),
  },
}))
vi.mock('./cateAgentController', () => ({ cateAgentController: { sendMessage: h.sendMessage } }))
vi.mock('./cateAgentTools', () => ({ deriveTopic: (t: string) => `topic:${t.slice(0, 4)}` }))
vi.mock('./directChatSession', () => ({ promptDirectChat: h.promptDirectChat }))

import { sendCateAgentMessage, sendDirectAgentMessage } from './cateAgentSend'

beforeEach(() => {
  vi.clearAllMocks()
  h.wsState = { observerView: false, activeChatId: '' }
  h.createChat.mockReturnValue({ id: 'new-chat', messages: [] })
})

describe('sendCateAgentMessage', () => {
  it('starts new requests in the full-capability direct agent', () => {
    const chat = { id: 'new-chat', title: 'topic:hell', messages: [] }
    h.createChat.mockReturnValue(chat)

    const chatId = sendDirectAgentMessage('ws1', '/root', 'hello world')

    expect(chatId).toBe('new-chat')
    expect(h.createChat).toHaveBeenCalledWith('/root', 'topic:hell')
    expect(h.setActiveChat).toHaveBeenCalledWith('ws1', 'new-chat')
    expect(h.promptDirectChat).toHaveBeenCalledWith(chat, 'ws1', '/root', 'hello world', undefined, undefined)
    expect(h.sendMessage).not.toHaveBeenCalled()
  })

  it('mints a new chat when none is active', () => {
    sendCateAgentMessage('ws1', '/root', 'hello world')
    expect(h.createChat).toHaveBeenCalledWith('/root', 'topic:hell')
    expect(h.setActiveChat).toHaveBeenCalledWith('ws1', 'new-chat')
    expect(h.promptDirectChat).toHaveBeenCalled()
    expect(h.sendMessage).not.toHaveBeenCalled()
  })

  it('always mints a new chat from the observer front door', () => {
    h.wsState = { observerView: true, activeChatId: 'existing' }
    h.getChat.mockReturnValue({ id: 'existing', engineeringTask: { goal: 'x' } })
    sendCateAgentMessage('ws1', '/root', 'again')
    expect(h.createChat).toHaveBeenCalledTimes(1)
    expect(h.promptDirectChat).toHaveBeenCalled()
    expect(h.sendMessage).not.toHaveBeenCalled()
  })

  it('composes into the active chat when one exists and observer is off', () => {
    h.wsState = { observerView: false, activeChatId: 'existing' }
    h.getChat.mockReturnValue({ id: 'existing', engineeringTask: { goal: 'x' } })
    sendCateAgentMessage('ws1', '/root', 'more')
    expect(h.createChat).not.toHaveBeenCalled()
    expect(h.setActiveChat).toHaveBeenCalledWith('ws1', 'existing')
    expect(h.sendMessage).toHaveBeenCalledWith('ws1', '/root', 'existing', 'more')
  })

  it('uses an explicitly selected panel chat instead of the workspace selection', () => {
    h.wsState = { observerView: false, activeChatId: 'sidebar-chat' }
    h.getChat.mockImplementation((_root: string, id: string) => id === 'panel-chat'
      ? { id, engineeringTask: { goal: 'x' } }
      : undefined)

    const chatId = sendCateAgentMessage('ws1', '/root', 'from panel', undefined, 'panel-chat')

    expect(chatId).toBe('panel-chat')
    expect(h.createChat).not.toHaveBeenCalled()
    expect(h.sendMessage).toHaveBeenCalledWith('ws1', '/root', 'panel-chat', 'from panel')
  })

  it('forwards the unified composer capabilities to the same chat turn', () => {
    h.getChat.mockReturnValue({ id: 'panel-chat', engineeringTask: { goal: 'x' } })
    const options = {
      images: [{ data: 'base64', mimeType: 'image/png', fileName: 'shot.png' }],
      thinkingLevel: 'high' as const,
      autoCompactionEnabled: false,
      planMode: true,
    }

    sendCateAgentMessage('ws1', '/root', 'inspect this', undefined, 'panel-chat', options)

    expect(h.sendMessage).toHaveBeenCalledWith(
      'ws1',
      '/root',
      'panel-chat',
      'inspect this',
      options,
    )
  })
})
