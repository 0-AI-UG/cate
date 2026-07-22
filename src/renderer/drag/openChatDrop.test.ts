// createSeededChatPanel is the shared drop half of chat drag-and-drop (Canvas +
// DockZone). These pin that a dropped chat mints an agent panel and stamps it to
// open that chat — a coding chat also re-tags the panel's worktree, and a
// recents-only coding session (no durable record) mints one so the drop resumes it.
//
// The stores are fully mocked (not spied) so this stays out of the appStore graph,
// which transitively pulls the terminal (xterm) runtime.

import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  createAgent: vi.fn(() => 'panel-new'),
  setPanelInitialChat: vi.fn(),
  setPanelWorktreeId: vi.fn(),
  getChatsByMode: vi.fn(() => [] as Array<{ id: string; sessionFile: string | null }>),
  createCodingChat: vi.fn(() => ({ id: 'chat-minted' })),
}))

vi.mock('../stores/appStore', () => ({
  useAppStore: {
    getState: () => ({
      selectedWorkspaceId: 'ws-1',
      createAgent: h.createAgent,
      setPanelInitialChat: h.setPanelInitialChat,
      setPanelWorktreeId: h.setPanelWorktreeId,
    }),
  },
}))

vi.mock('../stores/chatsStore', () => ({
  useChatsStore: {
    getState: () => ({
      getChatsByMode: h.getChatsByMode,
      createCodingChat: h.createCodingChat,
    }),
  },
}))

import { createSeededChatPanel } from './openChatDrop'

afterEach(() => {
  vi.clearAllMocks()
  h.getChatsByMode.mockReturnValue([])
})

describe('createSeededChatPanel', () => {
  it('creates an agent panel and stamps the dragged coding chat + its worktree', () => {
    const panelId = createSeededChatPanel(
      'ws-1',
      { chatId: 'chat-7', mode: 'coding', rootPath: '/repo', worktreeId: 'wt-3' },
      { x: 10, y: 20 },
      { target: 'canvas', canvasPanelId: 'cv-1' },
    )

    expect(panelId).toBe('panel-new')
    expect(h.createAgent).toHaveBeenCalledWith('ws-1', { x: 10, y: 20 }, { target: 'canvas', canvasPanelId: 'cv-1' })
    expect(h.setPanelInitialChat).toHaveBeenCalledWith('ws-1', 'panel-new', 'chat-7')
    expect(h.setPanelWorktreeId).toHaveBeenCalledWith('ws-1', 'panel-new', 'wt-3')
    expect(h.createCodingChat).not.toHaveBeenCalled()
  })

  it('stamps a loop chat without tagging a worktree', () => {
    createSeededChatPanel('ws-1', { chatId: 'loop-1', mode: 'loop', rootPath: '/repo' })

    expect(h.setPanelInitialChat).toHaveBeenCalledWith('ws-1', 'panel-new', 'loop-1')
    expect(h.setPanelWorktreeId).not.toHaveBeenCalled()
  })

  it('mints a durable coding chat for a recents session that has none, then stamps it', () => {
    createSeededChatPanel('ws-1', { mode: 'coding', rootPath: '/repo', sessionFile: '/repo/s.jsonl' })

    expect(h.createCodingChat).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({ sessionFile: '/repo/s.jsonl' }),
    )
    expect(h.setPanelInitialChat).toHaveBeenCalledWith('ws-1', 'panel-new', 'chat-minted')
  })

  it('reuses an existing durable chat matched by session file', () => {
    h.getChatsByMode.mockReturnValue([{ id: 'chat-existing', sessionFile: '/repo/s.jsonl' }])
    createSeededChatPanel('ws-1', { mode: 'coding', rootPath: '/repo', sessionFile: '/repo/s.jsonl' })

    expect(h.createCodingChat).not.toHaveBeenCalled()
    expect(h.setPanelInitialChat).toHaveBeenCalledWith('ws-1', 'panel-new', 'chat-existing')
  })
})
