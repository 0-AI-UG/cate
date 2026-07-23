import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chat } from '../../shared/types'
import {
  isPanelChat,
  isSidebarChat,
  useChatsStore,
} from './chatsStore'

const ROOT = '/repo'
const save = vi.fn()
const load = vi.fn(async () => [] as Chat[])

function chat(id: string, hostPanelId?: string): Chat {
  return {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    ...(hostPanelId ? { hostPanelId } : {}),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as unknown as { window: unknown }).window = {
    electronAPI: {
      projectChatsSave: save,
      projectChatsLoad: load,
    },
  }
  useChatsStore.setState({
    chatsByRoot: { [ROOT]: [chat('sidebar'), chat('panel-a', 'agent-a'), chat('panel-b', 'agent-b')] },
    loadedRoots: { [ROOT]: true },
  })
})

describe('chat host ownership', () => {
  it('treats legacy chats as sidebar-owned and panel chats as exclusive', () => {
    const [sidebar, panelA, panelB] = useChatsStore.getState().getChats(ROOT)

    expect(isSidebarChat(sidebar)).toBe(true)
    expect(isPanelChat(sidebar, 'agent-a')).toBe(false)
    expect(isPanelChat(panelA, 'agent-a')).toBe(true)
    expect(isPanelChat(panelA, 'agent-b')).toBe(false)
    expect(isPanelChat(panelB, 'agent-b')).toBe(true)
  })

  it('moves one durable record between panels and the sidebar', () => {
    const store = useChatsStore.getState()

    store.moveChat(ROOT, 'sidebar', 'agent-a')
    expect(store.getChat(ROOT, 'sidebar')?.hostPanelId).toBe('agent-a')

    useChatsStore.getState().moveChat(ROOT, 'sidebar', 'agent-b')
    expect(useChatsStore.getState().getChat(ROOT, 'sidebar')?.hostPanelId).toBe('agent-b')

    useChatsStore.getState().moveChat(ROOT, 'sidebar', null)
    expect(useChatsStore.getState().getChat(ROOT, 'sidebar')?.hostPanelId).toBeUndefined()
    expect(save).toHaveBeenCalledTimes(3)
  })

  it('returns only a closing panel’s chats to the sidebar', () => {
    useChatsStore.getState().releasePanelChats(ROOT, ['agent-a'])

    expect(useChatsStore.getState().getChat(ROOT, 'panel-a')?.hostPanelId).toBeUndefined()
    expect(useChatsStore.getState().getChat(ROOT, 'panel-b')?.hostPanelId).toBe('agent-b')
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('creates new chats in the requested host', () => {
    const sidebar = useChatsStore.getState().createChat(ROOT, 'Sidebar chat')
    const panel = useChatsStore.getState().createChat(ROOT, 'Panel chat', 'agent-a')

    expect(sidebar.hostPanelId).toBeUndefined()
    expect(panel.hostPanelId).toBe('agent-a')
  })

  it('coalesces concurrent loads so a late response cannot overwrite a move', async () => {
    useChatsStore.setState({ chatsByRoot: {}, loadedRoots: {} })
    load.mockResolvedValueOnce([chat('loaded')])

    await Promise.all([
      useChatsStore.getState().loadChats(ROOT),
      useChatsStore.getState().loadChats(ROOT),
    ])

    expect(load).toHaveBeenCalledTimes(1)
    expect(useChatsStore.getState().getChats(ROOT).map((candidate) => candidate.id)).toEqual(['loaded'])
  })
})
