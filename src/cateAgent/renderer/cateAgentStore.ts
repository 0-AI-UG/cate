import { create } from 'zustand'

export interface CateAgentWsState {
  /** Empty means the sidebar is showing the new-chat surface. */
  activeChatId: string
}

export const DEFAULT_CATE_AGENT_WS: CateAgentWsState = {
  activeChatId: '',
}

interface CateAgentStore {
  byWs: Record<string, CateAgentWsState>
  setActiveChat: (wsId: string, chatId: string) => void
  reset: (wsId: string) => void
}

export const useCateAgentStore = create<CateAgentStore>((set) => ({
  byWs: {},

  setActiveChat(wsId, chatId) {
    set((state) => ({
      byWs: {
        ...state.byWs,
        [wsId]: { activeChatId: chatId },
      },
    }))
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
