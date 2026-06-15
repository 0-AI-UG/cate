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

/** One ephemeral remark in the Cate Agent's speech-bubble stack. `id` is a
 *  process-unique sequence number so each remark's fade timer can remove exactly
 *  its own entry. */
export interface CateAgentRemark {
  id: number
  text: string
}

export interface CateAgentWsState {
  enabled: boolean
  /** Whether the observer runs automatically on the timer. When false the Cate Agent
   *  only observes when the user clicks the idle avatar. Mirrors .cate/cateAgent.json. */
  autoObserve: boolean
  activity: CateAgentActivity
  /** Short status-bubble text, e.g. "Running tests…" or "Proposing: update docs". */
  status: string
  /** Ephemeral FYIs the observer surfaced via remark(), newest last. Each entry
   *  auto-clears after a few seconds (see setRemark). They stack as speech bubbles
   *  so back-to-back remarks are all visible. Separate from `status` (activity). */
  remarks: CateAgentRemark[]
  /** The todo the executor is currently running, or null. */
  currentTodoId: string | null
}

export const DEFAULT_CATE_AGENT_WS: CateAgentWsState = {
  enabled: false,
  autoObserve: true,
  activity: 'off',
  status: '',
  remarks: [],
  currentTodoId: null,
}

interface CateAgentStore {
  byWs: Record<string, CateAgentWsState>
  get: (wsId: string) => CateAgentWsState
  patch: (wsId: string, patch: Partial<CateAgentWsState>) => void
  /** Dismiss one remark from the stack (user clicked it). Its fade timer becomes a
   *  harmless no-op since it filters by id. */
  popRemark: (wsId: string, id: number) => void
  reset: (wsId: string) => void
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

  popRemark(wsId, id) {
    set((s) => {
      const prev = s.byWs[wsId] ?? DEFAULT_CATE_AGENT_WS
      return { byWs: { ...s.byWs, [wsId]: { ...prev, remarks: prev.remarks.filter((r) => r.id !== id) } } }
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
