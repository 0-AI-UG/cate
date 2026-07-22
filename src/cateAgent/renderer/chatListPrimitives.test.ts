import { describe, expect, it } from 'vitest'
import { chatDragPayload } from './chatListPrimitives'
import type { Chat } from '../../shared/types'

describe('chatDragPayload', () => {
  it('identifies one durable Cate Agent chat without an engine mode', () => {
    const chat: Chat = {
      id: 'c1',
      title: 'T',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
    }
    expect(chatDragPayload(chat, '/root')).toEqual({ chatId: 'c1', rootPath: '/root' })
  })
})
