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
  /** Whether the toolbar is showing the prompt input bar (and the feedback panel
   *  is forced visible). */
  inputOpen: boolean
  /** Persistent-per-session feedback log shown above the toolbar, newest last. */
  feed: CateAgentFeedItem[]
  /** Terminals the orchestrator is actively driving → their pulsing glow color, keyed
   *  by panelId. The color is the job's worktree color, or the theme accent
   *  (`rgb(var(--agent-rgb))`) when the job runs with no worktree. */
  controlledTerminals: Record<string, string>
  /** Agent activity has arrived (a remark, proposal, review, or error) that the
   *  user hasn't seen because the feedback panel was closed. Drives the toolbar
   *  button's attention glow + notification dot. Cleared when the panel opens. */
  unseen: boolean
}

export const DEFAULT_CATE_AGENT_WS: CateAgentWsState = {
  enabled: false,
  autoObserve: true,
  activity: 'off',
  status: '',
  inputOpen: false,
  feed: [],
  controlledTerminals: {},
  unseen: false,
}

interface CateAgentStore {
  byWs: Record<string, CateAgentWsState>
  get: (wsId: string) => CateAgentWsState
  patch: (wsId: string, patch: Partial<CateAgentWsState>) => void
  reset: (wsId: string) => void
  setInputOpen: (wsId: string, open: boolean) => void
  appendFeed: (wsId: string, kind: CateAgentFeedKind, text: string) => void
  /** Remove a single feed line by id (the per-remark dismiss button). */
  dismissFeedItem: (wsId: string, id: number) => void
  clearFeed: (wsId: string) => void
  /** Flag/clear unseen agent activity (drives the toolbar attention indicator). */
  setUnseen: (wsId: string, value: boolean) => void
  addControlledTerminal: (wsId: string, panelId: string, color: string) => void
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
      // Opening the panel means the user has now seen any pending activity.
      return { byWs: { ...s.byWs, [wsId]: { ...prev, inputOpen: open, unseen: open ? false : prev.unseen } } }
    })
  },

  appendFeed(wsId, kind, text) {
    set((s) => {
      const prev = s.byWs[wsId] ?? DEFAULT_CATE_AGENT_WS
      const item: CateAgentFeedItem = { id: ++feedSeq, kind, text, ts: Date.now() }
      // Agent output (anything but the user's own line) arriving while the panel
      // is closed becomes unseen activity → toolbar attention indicator.
      const unseen = prev.unseen || (kind !== 'user' && !prev.inputOpen)
      return { byWs: { ...s.byWs, [wsId]: { ...prev, feed: [...prev.feed, item].slice(-MAX_FEED), unseen } } }
    })
  },

  dismissFeedItem(wsId, id) {
    set((s) => {
      const prev = s.byWs[wsId] ?? DEFAULT_CATE_AGENT_WS
      const feed = prev.feed.filter((f) => f.id !== id)
      if (feed.length === prev.feed.length) return s
      return { byWs: { ...s.byWs, [wsId]: { ...prev, feed } } }
    })
  },

  setUnseen(wsId, value) {
    set((s) => {
      const prev = s.byWs[wsId] ?? DEFAULT_CATE_AGENT_WS
      return { byWs: { ...s.byWs, [wsId]: { ...prev, unseen: value } } }
    })
  },

  clearFeed(wsId) {
    set((s) => {
      const prev = s.byWs[wsId] ?? DEFAULT_CATE_AGENT_WS
      return { byWs: { ...s.byWs, [wsId]: { ...prev, feed: [] } } }
    })
  },

  addControlledTerminal(wsId, panelId, color) {
    set((s) => {
      const prev = s.byWs[wsId] ?? DEFAULT_CATE_AGENT_WS
      if (prev.controlledTerminals[panelId] === color) return s
      return { byWs: { ...s.byWs, [wsId]: { ...prev, controlledTerminals: { ...prev.controlledTerminals, [panelId]: color } } } }
    })
  },

  removeControlledTerminal(wsId, panelId) {
    set((s) => {
      const prev = s.byWs[wsId] ?? DEFAULT_CATE_AGENT_WS
      if (!(panelId in prev.controlledTerminals)) return s
      const next = { ...prev.controlledTerminals }
      delete next[panelId]
      return { byWs: { ...s.byWs, [wsId]: { ...prev, controlledTerminals: next } } }
    })
  },

  clearControlledTerminals(wsId) {
    set((s) => {
      const prev = s.byWs[wsId] ?? DEFAULT_CATE_AGENT_WS
      return { byWs: { ...s.byWs, [wsId]: { ...prev, controlledTerminals: {} } } }
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

/** Hook: the glow color for a terminal the orchestrator is driving, or null when it
 *  isn't controlled. The color is the job's worktree color (theme accent when the
 *  job has no worktree). */
export function useTerminalGlow(wsId: string | null | undefined, panelId: string): string | null {
  return useCateAgentStore((s) => (wsId ? s.byWs[wsId]?.controlledTerminals?.[panelId] ?? null : null))
}
