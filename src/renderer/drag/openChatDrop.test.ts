import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  createCateAgent: vi.fn(() => 'panel-new'),
  setPanelInitialChat: vi.fn(),
  moveChat: vi.fn(),
}))

vi.mock('../stores/appStore', () => ({
  useAppStore: {
    getState: () => ({
      workspaces: [{ id: 'ws-1', rootPath: '/repo' }],
      createCateAgent: h.createCateAgent,
      setPanelInitialChat: h.setPanelInitialChat,
    }),
  },
}))

vi.mock('../stores/chatsStore', () => ({
  useChatsStore: {
    getState: () => ({ loadedRoots: { '/repo': true }, moveChat: h.moveChat }),
  },
}))

import { createSeededChatPanel } from './openChatDrop'

afterEach(() => vi.clearAllMocks())

describe('createSeededChatPanel', () => {
  it('creates a Cate Agent panel seeded with the dragged chat', () => {
    const panelId = createSeededChatPanel(
      'ws-1',
      { chatId: 'chat-7', rootPath: '/repo' },
      { x: 10, y: 20 },
      { target: 'canvas', canvasPanelId: 'cv-1' },
    )

    expect(panelId).toBe('panel-new')
    expect(h.createCateAgent).toHaveBeenCalledWith(
      'ws-1',
      { x: 10, y: 20 },
      { target: 'canvas', canvasPanelId: 'cv-1' },
    )
    expect(h.setPanelInitialChat).toHaveBeenCalledWith('ws-1', 'panel-new', 'chat-7')
    expect(h.moveChat).toHaveBeenCalledWith('/repo', 'chat-7', 'panel-new')
  })

  it('does nothing without a workspace', () => {
    expect(createSeededChatPanel('', { chatId: 'chat-7', rootPath: '/repo' })).toBeNull()
    expect(h.createCateAgent).not.toHaveBeenCalled()
  })

  it('does not move a chat into a workspace for another root', () => {
    expect(createSeededChatPanel('ws-1', { chatId: 'chat-7', rootPath: '/other' })).toBeNull()
    expect(h.createCateAgent).not.toHaveBeenCalled()
    expect(h.moveChat).not.toHaveBeenCalled()
  })
})
