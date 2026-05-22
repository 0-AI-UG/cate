// =============================================================================
// urlPromptStore — Pending "open this URL?" prompts surfaced from terminal
// output when the autoOpenUrlsFromTerminal setting is 'prompt'. Prompts are
// queued per terminal panelId so multiple URLs printed by a dev server (e.g.
// Vite's "Local:" + "Network:") each get their own confirmation instead of
// overwriting each other.
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
  /** Pending prompts queued per terminal panelId. The first entry is the one
   *  currently displayed; accept/dismiss advances to the next. */
  promptsByPanel: Record<string, UrlPrompt[]>
}

interface UrlPromptStoreActions {
  request: (panelId: string, workspaceId: string, url: string) => void
  accept: (panelId: string) => void
  dismiss: (panelId: string) => void
}

export type UrlPromptStore = UrlPromptStoreState & UrlPromptStoreActions

let counter = 0
const MAX_QUEUE_PER_PANEL = 8

export const useUrlPromptStore = create<UrlPromptStore>((set, get) => ({
  promptsByPanel: {},

  request(panelId, workspaceId, url) {
    set((state) => {
      const queue = state.promptsByPanel[panelId] ?? []
      if (queue.some((p) => p.url === url)) return state
      const prompt: UrlPrompt = { id: `urlprompt-${++counter}`, panelId, workspaceId, url }
      const next = [...queue, prompt].slice(-MAX_QUEUE_PER_PANEL)
      return { promptsByPanel: { ...state.promptsByPanel, [panelId]: next } }
    })
  },

  accept(panelId) {
    const queue = get().promptsByPanel[panelId]
    if (!queue || queue.length === 0) return
    const [head, ...rest] = queue
    openTerminalUrl(head.workspaceId, head.url)
    set((state) => {
      const next = { ...state.promptsByPanel }
      if (rest.length === 0) delete next[panelId]
      else next[panelId] = rest
      return { promptsByPanel: next }
    })
  },

  dismiss(panelId) {
    set((state) => {
      const queue = state.promptsByPanel[panelId]
      if (!queue || queue.length === 0) return state
      const rest = queue.slice(1)
      const next = { ...state.promptsByPanel }
      if (rest.length === 0) delete next[panelId]
      else next[panelId] = rest
      return { promptsByPanel: next }
    })
  },
}))
