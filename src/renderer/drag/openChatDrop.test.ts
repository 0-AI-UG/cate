import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  createCateAgent: vi.fn(() => 'panel-new'),
  setPanelInitialChat: vi.fn(),
}))

vi.mock('../stores/appStore', () => ({
  useAppStore: {
    getState: () => ({
      createCateAgent: h.createCateAgent,
      setPanelInitialChat: h.setPanelInitialChat,
    }),
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
  })

  it('does nothing without a workspace', () => {
    expect(createSeededChatPanel('', { chatId: 'chat-7', rootPath: '/repo' })).toBeNull()
    expect(h.createCateAgent).not.toHaveBeenCalled()
  })
})
