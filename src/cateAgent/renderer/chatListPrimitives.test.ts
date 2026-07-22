import { describe, expect, it } from 'vitest'
import { chatDragPayload } from './chatListPrimitives'
import type { Chat } from '../../shared/types'

const base = (over: Partial<Chat>): Chat =>
  ({ id: 'c1', title: 'T', messages: [], ...over }) as Chat

describe('chatDragPayload', () => {
  it('builds a coding payload with the optional session fields spread in', () => {
    const chat = base({
      mode: 'coding',
      agentKey: 'k1',
      sessionFile: '/s.json',
      worktreeId: 'wt1',
    })
    expect(chatDragPayload(chat, '/root')).toEqual({
      chatId: 'c1',
      mode: 'coding',
      rootPath: '/root',
      agentKey: 'k1',
      sessionFile: '/s.json',
      worktreeId: 'wt1',
    })
  })

  it('omits absent optional coding fields', () => {
    const chat = base({ mode: 'coding', agentKey: 'k1' })
    expect(chatDragPayload(chat, '/root')).toEqual({
      chatId: 'c1',
      mode: 'coding',
      rootPath: '/root',
      agentKey: 'k1',
    })
  })

  it('builds a bare loop payload (no session fields) for a loop chat', () => {
    const chat = base({ mode: 'loop', agentKey: 'ignored' })
    expect(chatDragPayload(chat, '/root')).toEqual({
      chatId: 'c1',
      mode: 'loop',
      rootPath: '/root',
    })
  })

  it('treats a legacy mode-less chat as loop', () => {
    const chat = base({})
    expect(chatDragPayload(chat, '/root')).toEqual({
      chatId: 'c1',
      mode: 'loop',
      rootPath: '/root',
    })
  })
})
