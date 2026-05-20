// =============================================================================
// urlPromptStore — Pending "open this URL?" prompts surfaced from terminal
// output when the autoOpenUrlsFromTerminal setting is 'prompt'. Prompts are
// keyed by the terminal panelId that produced them so each TerminalPanel can
// render its own inline confirmation strip.
// =============================================================================

import { create } from 'zustand'
import { openTerminalUrl } from '../lib/terminalUrlAutoOpen'

export interface UrlPrompt {
  id: string
  panelId: string
  workspaceId: string
  url: string
}

interface UrlPromptStoreState {
  /** Pending prompts keyed by terminal panelId. At most one prompt per panel —
   *  newer URLs replace older unresolved ones so a chatty dev server can't
   *  pile up. */
  promptsByPanel: Record<string, UrlPrompt>
}

interface UrlPromptStoreActions {
  request: (panelId: string, workspaceId: string, url: string) => void
  accept: (panelId: string) => void
  dismiss: (panelId: string) => void
}

export type UrlPromptStore = UrlPromptStoreState & UrlPromptStoreActions

let counter = 0

export const useUrlPromptStore = create<UrlPromptStore>((set, get) => ({
  promptsByPanel: {},

  request(panelId, workspaceId, url) {
    set((state) => {
      const existing = state.promptsByPanel[panelId]
      if (existing && existing.url === url) return state
      const prompt: UrlPrompt = { id: `urlprompt-${++counter}`, panelId, workspaceId, url }
      return { promptsByPanel: { ...state.promptsByPanel, [panelId]: prompt } }
    })
  },

  accept(panelId) {
    const prompt = get().promptsByPanel[panelId]
    if (!prompt) return
    openTerminalUrl(prompt.workspaceId, prompt.url)
    set((state) => {
      const next = { ...state.promptsByPanel }
      delete next[panelId]
      return { promptsByPanel: next }
    })
  },

  dismiss(panelId) {
    set((state) => {
      if (!state.promptsByPanel[panelId]) return state
      const next = { ...state.promptsByPanel }
      delete next[panelId]
      return { promptsByPanel: next }
    })
  },
}))
