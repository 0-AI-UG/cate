import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chat } from '../../shared/types'
import {
  beginChatDrag,
  endChatDrag,
  showChatDropGhost,
  useChatDragState,
} from './chatDragState'
import { CHAT_DRAG_MIME } from './fileDragPayload'

const chat: Chat = {
  id: 'chat-1',
  title: 'Dragged chat',
  createdAt: 1,
  updatedAt: 1,
  messages: [],
  hostPanelId: 'agent-1',
}

beforeEach(() => {
  endChatDrag()
})

describe('chatDragState', () => {
  it('publishes the native payload and one destination-list preview', () => {
    const setData = vi.fn()
    beginChatDrag({ setData } as unknown as DataTransfer, {
      chat,
      rootPath: '/project',
      sourceHostPanelId: 'agent-1',
    })
    useChatDragState.getState().setDestination(null)

    expect(setData).toHaveBeenCalledWith(
      CHAT_DRAG_MIME,
      JSON.stringify({ chatId: chat.id, rootPath: '/project' }),
    )
    expect(showChatDropGhost(
      useChatDragState.getState().active,
      useChatDragState.getState().destinationHostPanelId,
      '/project',
      null,
    )).toBe(true)
  })

  it('does not preview the source list, another root, or a host the pointer left', () => {
    const active = { chat, rootPath: '/project', sourceHostPanelId: 'agent-1' }

    expect(showChatDropGhost(active, 'agent-1', '/project', 'agent-1')).toBe(false)
    expect(showChatDropGhost(active, null, '/other', null)).toBe(false)
    expect(showChatDropGhost(active, undefined, '/project', null)).toBe(false)
  })

  it('clears both the preview and destination when dragging ends', () => {
    useChatDragState.setState({
      active: { chat, rootPath: '/project', sourceHostPanelId: 'agent-1' },
      destinationHostPanelId: null,
    })

    endChatDrag()

    expect(useChatDragState.getState().active).toBeNull()
    expect(useChatDragState.getState().destinationHostPanelId).toBeUndefined()
  })
})
