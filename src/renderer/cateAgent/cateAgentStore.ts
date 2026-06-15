// =============================================================================
// cateAgentStore — renderer runtime state for the Cate Agent, keyed by workspace id.
//
// Pure observable state for the UI (Tasks header, avatar). The imperative brain
// (sessions, timers, loops) lives in cateAgentController.ts; it writes here so the
// UI reflects what the Cate Agent is doing. Enablement/pause are persisted to
// .cate/cateAgent.json by the controller — this store is the live mirror.
// =============================================================================

import { create } from 'zustand'
import type { CateAgentActivity } from '../../shared/types'

/** One entry in the Cate Agent's persistent-per-session feedback log (rendered in
 *  the feedback panel above the toolbar). Feed items stay until the feed is
 *  cleared or rolls past the cap. */
export type CateAgentFeedKind = 'user' | 'agent' | 'status' | 'error'

export interface CateAgentFeedItem {
  id: number
  kind: CateAgentFeedKind
  text: string
  ts: number
}

let feedSeq = 0
const MAX_FEED = 50

export interface CateAgentWsState {
  enabled: boolean
  /** Whether the observer runs automatically on the timer. When false the Cate Agent
   *  only observes when the user clicks the idle avatar. Mirrors .cate/cateAgent.json. */
  autoObserve: boolean
  activity: CateAgentActivity
  /** Short status-bubble text, e.g. "Running tests…" or "Proposing: update docs". */
  status: string
  /** The todo the executor is currently running, or null. */
  currentTodoId: string | null
  /** Whether the toolbar is showing the prompt input bar (and the feedback panel
   *  is forced visible). */
  inputOpen: boolean
  /** Persistent-per-session feedback log shown above the toolbar, newest last. */
  feed: CateAgentFeedItem[]
  /** panelIds of terminals the executor is actively driving — drives the glow. */
  controlledTerminalIds: string[]
}

export const DEFAULT_CATE_AGENT_WS: CateAgentWsState = {
  enabled: false,
  autoObserve: true,
  activity: 'off',
  status: '',
  currentTodoId: null,
  inputOpen: false,
  feed: [],
  controlledTerminalIds: [],
}

interface CateAgentStore {
  byWs: Record<string, CateAgentWsState>
  get: (wsId: string) => CateAgentWsState
  patch: (wsId: string, patch: Partial<CateAgentWsState>) => void
  reset: (wsId: string) => void
  setInputOpen: (wsId: string, open: boolean) => void
  appendFeed: (wsId: string, kind: CateAgentFeedKind, text: string) => void
  clearFeed: (wsId: string) => void
  addControlledTerminal: (wsId: string, panelId: string) => void
  removeControlledTerminal: (wsId: string, panelId: string) => void
  clearControlledTerminals: (wsId: string) => void
}

export const useCateAgentStore = create<CateAgentStore>((set, getStore) => ({
  byWs: {},

  get(wsId) {
    return getStore().byWs[wsId] ?? DEFAULT_CATE_AGENT_WS
  },

  patch(wsId, patch) {
    set((s) => {
      const prev = s.byWs[wsId] ?? DEFAULT_CATE_AGENT_WS
      return { byWs: { ...s.byWs, [wsId]: { ...prev, ...patch } } }
    })
  },

  setInputOpen(wsId, open) {
    set((s) => {
      const prev = s.byWs[wsId] ?? DEFAULT_CATE_AGENT_WS
      return { byWs: { ...s.byWs, [wsId]: { ...prev, inputOpen: open } } }
    })
  },

  appendFeed(wsId, kind, text) {
    set((s) => {
      const prev = s.byWs[wsId] ?? DEFAULT_CATE_AGENT_WS
      const item: CateAgentFeedItem = { id: ++feedSeq, kind, text, ts: Date.now() }
      return { byWs: { ...s.byWs, [wsId]: { ...prev, feed: [...prev.feed, item].slice(-MAX_FEED) } } }
    })
  },

  clearFeed(wsId) {
    set((s) => {
      const prev = s.byWs[wsId] ?? DEFAULT_CATE_AGENT_WS
      return { byWs: { ...s.byWs, [wsId]: { ...prev, feed: [] } } }
    })
  },

  addControlledTerminal(wsId, panelId) {
    set((s) => {
      const prev = s.byWs[wsId] ?? DEFAULT_CATE_AGENT_WS
      if (prev.controlledTerminalIds.includes(panelId)) return s
      return { byWs: { ...s.byWs, [wsId]: { ...prev, controlledTerminalIds: [...prev.controlledTerminalIds, panelId] } } }
    })
  },

  removeControlledTerminal(wsId, panelId) {
    set((s) => {
      const prev = s.byWs[wsId] ?? DEFAULT_CATE_AGENT_WS
      return { byWs: { ...s.byWs, [wsId]: { ...prev, controlledTerminalIds: prev.controlledTerminalIds.filter((p) => p !== panelId) } } }
    })
  },

  clearControlledTerminals(wsId) {
    set((s) => {
      const prev = s.byWs[wsId] ?? DEFAULT_CATE_AGENT_WS
      return { byWs: { ...s.byWs, [wsId]: { ...prev, controlledTerminalIds: [] } } }
    })
  },

  reset(wsId) {
    set((s) => ({ byWs: { ...s.byWs, [wsId]: { ...DEFAULT_CATE_AGENT_WS } } }))
  },
}))

/** Hook: subscribe to one workspace's Cate Agent state (stable default when absent). */
export function useCateAgentWs(wsId: string | null | undefined): CateAgentWsState {
  return useCateAgentStore((s) => (wsId ? s.byWs[wsId] ?? DEFAULT_CATE_AGENT_WS : DEFAULT_CATE_AGENT_WS))
}

/** Hook: true while the given terminal panel is being driven by the executor. */
export function useTerminalControlled(wsId: string | null | undefined, panelId: string): boolean {
  return useCateAgentStore((s) =>
    wsId ? (s.byWs[wsId]?.controlledTerminalIds ?? []).includes(panelId) : false,
  )
}
