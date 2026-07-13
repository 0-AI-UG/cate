import { describe, expect, it, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  getChat: vi.fn(),
  createChat: vi.fn(),
  setActiveChat: vi.fn(),
  sendMessage: vi.fn(),
  wsState: { observerView: false, activeChatId: '' } as { observerView: boolean; activeChatId: string },
}))

vi.mock('../stores/chatsStore', () => ({
  useChatsStore: { getState: () => ({ getChat: h.getChat, createChat: h.createChat }) },
}))
vi.mock('./cateAgentStore', () => ({
  useCateAgentStore: {
    getState: () => ({ byWs: { ws1: h.wsState }, setActiveChat: h.setActiveChat }),
  },
}))
vi.mock('./cateAgentController', () => ({ cateAgentController: { sendMessage: h.sendMessage } }))
vi.mock('./cateAgentTools', () => ({ deriveTopic: (t: string) => `topic:${t.slice(0, 4)}` }))

import { sendCateAgentMessage } from './cateAgentSend'

beforeEach(() => {
  vi.clearAllMocks()
  h.wsState = { observerView: false, activeChatId: '' }
  h.createChat.mockReturnValue({ id: 'new-chat' })
})

describe('sendCateAgentMessage', () => {
  it('mints a new chat when none is active', () => {
    sendCateAgentMessage('ws1', '/root', 'hello world')
    expect(h.createChat).toHaveBeenCalledWith('/root', 'topic:hell')
    expect(h.setActiveChat).toHaveBeenCalledWith('ws1', 'new-chat')
    expect(h.sendMessage).toHaveBeenCalledWith('ws1', '/root', 'new-chat', 'hello world')
  })

  it('always mints a new chat from the observer front door', () => {
    h.wsState = { observerView: true, activeChatId: 'existing' }
    h.getChat.mockReturnValue({ id: 'existing' })
    sendCateAgentMessage('ws1', '/root', 'again')
    expect(h.createChat).toHaveBeenCalledTimes(1)
    expect(h.sendMessage).toHaveBeenCalledWith('ws1', '/root', 'new-chat', 'again')
  })

  it('composes into the active chat when one exists and observer is off', () => {
    h.wsState = { observerView: false, activeChatId: 'existing' }
    h.getChat.mockReturnValue({ id: 'existing' })
    sendCateAgentMessage('ws1', '/root', 'more')
    expect(h.createChat).not.toHaveBeenCalled()
    expect(h.setActiveChat).toHaveBeenCalledWith('ws1', 'existing')
    expect(h.sendMessage).toHaveBeenCalledWith('ws1', '/root', 'existing', 'more')
  })
})
