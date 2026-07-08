// =============================================================================
// cateAgentStore — renderer runtime state for the Cate Agent, keyed by workspace id.
//
// Pure observable state for the UI (Tasks header, toolbar button). The imperative
// brain (sessions, timers, loops) lives in cateAgentController.ts; it writes here
// so the UI reflects what the Cate Agent is doing. autoObserve is persisted to
// .cate/cateAgent.json by the controller — this store is the live mirror.
// =============================================================================

import { create } from 'zustand'
import type { CateAgentActivity, Point } from '../../shared/types'

/** One entry in the Cate Agent's persistent-per-session feedback log (rendered in
 *  the feedback panel above the toolbar). Feed items stay until the feed is
 *  cleared or rolls past the cap. */
export type CateAgentFeedKind = 'user' | 'agent' | 'status' | 'error'

/** An observer-authored, ready-to-run prompt for the Cate Agent. When a feed item
 *  carries one, the timeline renders a call-to-action button labelled `label`
 *  (the observer's free choice, e.g. "Fix", "Implement") that starts a new chat
 *  with `prompt`. */
export interface CateAgentFeedAction {
  label: string
  prompt: string
}

export interface CateAgentFeedItem {
  id: number
  kind: CateAgentFeedKind
  text: string
  ts: number
  /** Present on a suggestion: a one-click prompt the user can run as a new chat. */
  action?: CateAgentFeedAction
  /** A suggestion, once acted on, stays in the feed as a record but can't be run or
   *  dismissed again. Undefined = still pending; 'approved' = the user ran it;
   *  'dismissed' = the user waved it off. */
  resolved?: 'approved' | 'dismissed'
}

let feedSeq = 0
const MAX_FEED = 50

export interface CateAgentWsState {
  /** Whether the observer runs automatically on the timer. When false the Cate Agent
   *  only observes when the user asks it to. Mirrors .cate/cateAgent.json. */
  autoObserve: boolean
  activity: CateAgentActivity
  /** Short status-bubble text, e.g. "Running tests…" or "Proposing: update docs". */
  status: string
  /** Whether the toolbar is showing the prompt input bar (and the chat panel is
   *  forced visible). */
  inputOpen: boolean
  /** The chat the input composes into and the transcript shows. Empty string means
   *  "compose a new chat" (one is minted on the first send). */
  activeChatId: string
  /** The observer timeline owns the panel body instead of a chat. This is the
   *  DEFAULT the panel opens onto (the front door): a compact, read-only view of
   *  what the observer has watched. Picking a chat (or sending a first message)
   *  turns it off and grows the window into that chat. */
  observerView: boolean
  /** Persistent-per-session feedback log shown above the toolbar, newest last. */
  feed: CateAgentFeedItem[]
  /** Terminals the orchestrator is actively driving → their pulsing glow color, keyed
   *  by panelId. The color is the job's worktree color, or the theme accent
   *  (`rgb(var(--agent-rgb))`) when the job runs with no worktree. */
  controlledTerminals: Record<string, string>
  /** Anchor of each run's agent-terminal grid, keyed by run (todoId). Computed
   *  from the canvas content when the run's first terminal opens and dropped
   *  when the run is finalized, so a later re-run re-anchors beside the canvas
   *  as it looks THEN (see cateAgentTerminals.terminalPosition). */
  runAnchors: Record<string, Point>
  /** Agent activity has arrived (a remark, proposal, review, or error) that the
   *  user hasn't seen because the feedback panel was closed. Drives the toolbar
   *  button's attention glow + notification dot. Cleared when the panel opens. */
  unseen: boolean
}

export const DEFAULT_CATE_AGENT_WS: CateAgentWsState = {
  autoObserve: true,
  activity: 'off',
  status: '',
  inputOpen: false,
  activeChatId: '',
  observerView: false,
  feed: [],
  controlledTerminals: {},
  runAnchors: {},
  unseen: false,
}

interface CateAgentStore {
  byWs: Record<string, CateAgentWsState>
  get: (wsId: string) => CateAgentWsState
  patch: (wsId: string, patch: Partial<CateAgentWsState>) => void
  reset: (wsId: string) => void
  setInputOpen: (wsId: string, open: boolean) => void
  /** Select the active chat (empty string = compose a new one). */
  setActiveChat: (wsId: string, chatId: string) => void
  /** Toggle the observer timeline view (eye tab) on/off. */
  setObserverView: (wsId: string, value: boolean) => void
  appendFeed: (wsId: string, kind: CateAgentFeedKind, text: string, action?: CateAgentFeedAction) => void
  /** Remove a single feed line by id (the per-remark dismiss button). */
  dismissFeedItem: (wsId: string, id: number) => void
  /** Mark a suggestion acted-on (run or waved off). It stays in the feed as a record
   *  but its button + dismiss are spent — idempotent, so it can't resolve twice. */
  resolveFeedAction: (wsId: string, id: number, resolution: 'approved' | 'dismissed') => void
  clearFeed: (wsId: string) => void
  /** Flag/clear unseen agent activity (drives the toolbar attention indicator). */
  setUnseen: (wsId: string, value: boolean) => void
  addControlledTerminal: (wsId: string, panelId: string, color: string) => void
  removeControlledTerminal: (wsId: string, panelId: string) => void
  clearControlledTerminals: (wsId: string) => void
  setRunAnchor: (wsId: string, runKey: string, anchor: Point) => void
  clearRunAnchor: (wsId: string, runKey: string) => void
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
      // Opening the panel means the user has now seen any pending activity, and it
      // opens onto the observer (the front door) by default — not a chat. Closing
      // drops the observer view so the next open starts clean.
      return {
        byWs: {
          ...s.byWs,
          [wsId]: { ...prev, inputOpen: open, unseen: open ? false : prev.unseen, observerView: open },
        },
      }
    })
  },

  setActiveChat(wsId, chatId) {
    set((s) => {
      const prev = s.byWs[wsId] ?? DEFAULT_CATE_AGENT_WS
      // Picking a chat always leaves the observer timeline.
      return { byWs: { ...s.byWs, [wsId]: { ...prev, activeChatId: chatId, observerView: false } } }
    })
  },

  setObserverView(wsId, value) {
    set((s) => {
      const prev = s.byWs[wsId] ?? DEFAULT_CATE_AGENT_WS
      return { byWs: { ...s.byWs, [wsId]: { ...prev, observerView: value } } }
    })
  },

  appendFeed(wsId, kind, text, action) {
    set((s) => {
      const prev = s.byWs[wsId] ?? DEFAULT_CATE_AGENT_WS
      const item: CateAgentFeedItem = { id: ++feedSeq, kind, text, ts: Date.now(), action }
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

  resolveFeedAction(wsId, id, resolution) {
    set((s) => {
      const prev = s.byWs[wsId] ?? DEFAULT_CATE_AGENT_WS
      // Only pending suggestions resolve; already-resolved (or plain) items are left
      // untouched so a double-click can't re-run or re-dismiss.
      const target = prev.feed.find((f) => f.id === id)
      if (!target || !target.action || target.resolved) return s
      const feed = prev.feed.map((f) => (f.id === id ? { ...f, resolved: resolution } : f))
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
      // No feed means nothing for the eye to show, so the toolbar dot must go dark too.
      return { byWs: { ...s.byWs, [wsId]: { ...prev, feed: [], unseen: false } } }
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

  setRunAnchor(wsId, runKey, anchor) {
    set((s) => {
      const prev = s.byWs[wsId] ?? DEFAULT_CATE_AGENT_WS
      return { byWs: { ...s.byWs, [wsId]: { ...prev, runAnchors: { ...prev.runAnchors, [runKey]: anchor } } } }
    })
  },

  clearRunAnchor(wsId, runKey) {
    set((s) => {
      const prev = s.byWs[wsId] ?? DEFAULT_CATE_AGENT_WS
      if (!(runKey in prev.runAnchors)) return s
      const next = { ...prev.runAnchors }
      delete next[runKey]
      return { byWs: { ...s.byWs, [wsId]: { ...prev, runAnchors: next } } }
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
