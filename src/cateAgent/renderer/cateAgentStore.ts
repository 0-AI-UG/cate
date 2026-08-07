import { create } from 'zustand'
import { useMemo } from 'react'
import { useChatsStore } from '../../renderer/stores/chatsStore'

export interface CateAgentWsState {
  /** Empty means the sidebar is showing the new-chat surface. */
  activeChatId: string
}

export const DEFAULT_CATE_AGENT_WS: CateAgentWsState = {
  activeChatId: '',
}

interface CateAgentStore {
  byWs: Record<string, CateAgentWsState>
  activeChatByPanel: Record<string, string>
  setActiveChat: (wsId: string, chatId: string) => void
  setPanelActiveChat: (panelId: string, chatId: string | null) => void
  reset: (wsId: string) => void
}

export const useCateAgentStore = create<CateAgentStore>((set) => ({
  byWs: {},
  activeChatByPanel: {},

  setActiveChat(wsId, chatId) {
    set((state) => ({
      byWs: {
        ...state.byWs,
        [wsId]: { activeChatId: chatId },
      },
    }))
  },

  setPanelActiveChat(panelId, chatId) {
    set((state) => {
      if ((state.activeChatByPanel[panelId] ?? '') === (chatId ?? '')) return state
      const activeChatByPanel = { ...state.activeChatByPanel }
      if (chatId) activeChatByPanel[panelId] = chatId
      else delete activeChatByPanel[panelId]
      return { activeChatByPanel }
    })
  },

  reset(wsId) {
    set((state) => ({
      byWs: {
        ...state.byWs,
        [wsId]: { ...DEFAULT_CATE_AGENT_WS },
      },
    }))
  },
}))

export function useCateAgentWs(wsId: string | null | undefined): CateAgentWsState {
  return useCateAgentStore((state) => (
    wsId ? state.byWs[wsId] ?? DEFAULT_CATE_AGENT_WS : DEFAULT_CATE_AGENT_WS
  ))
}

/** Resolve the active chat target for non-React creation paths that inherit the
 * selected canvas node's worktree. Chat ids are globally generated, so scanning
 * the already-loaded workspace lists is unambiguous. */
export function activeChatWorktreeIdForPanel(panelId: string): string | undefined {
  const chatId = useCateAgentStore.getState().activeChatByPanel[panelId]
  if (!chatId) return undefined
  for (const chats of Object.values(useChatsStore.getState().chatsByRoot)) {
    const chat = chats.find((candidate) => candidate.id === chatId)
    if (chat) return chat.worktreeId
  }
  return undefined
}

/** Reactive panel projection used only by canvas/tab chrome. The worktree value
 * remains owned by Chat; this map is derived UI state, never persisted. */
export function useActiveChatWorktreeByPanel(): Record<string, string> {
  const activeChatByPanel = useCateAgentStore((state) => state.activeChatByPanel)
  const chatsByRoot = useChatsStore((state) => state.chatsByRoot)
  return useMemo(() => {
    const worktreeByChat = new Map<string, string>()
    for (const chats of Object.values(chatsByRoot)) {
      for (const chat of chats) {
        if (chat.worktreeId) worktreeByChat.set(chat.id, chat.worktreeId)
      }
    }
    const out: Record<string, string> = {}
    for (const [panelId, chatId] of Object.entries(activeChatByPanel)) {
      const worktreeId = worktreeByChat.get(chatId)
      if (worktreeId) out[panelId] = worktreeId
    }
    return out
  }, [activeChatByPanel, chatsByRoot])
}
