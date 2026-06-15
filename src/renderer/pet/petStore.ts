// =============================================================================
// petStore — renderer runtime state for the Canvas Pet, keyed by workspace id.
//
// Pure observable state for the UI (Tasks header, avatar). The imperative brain
// (sessions, timers, loops) lives in petController.ts; it writes here so the UI
// reflects what the pet is doing. Enablement/pause are persisted to .cate/pet.json
// by the controller — this store is the live mirror.
// =============================================================================

import { create } from 'zustand'
import type { PetActivity } from '../../shared/types'

export interface PetWsState {
  enabled: boolean
  paused: boolean
  /** Whether the observer runs automatically on the timer. When false the pet
   *  only observes when the user clicks the idle avatar. Mirrors .cate/pet.json. */
  autoObserve: boolean
  activity: PetActivity
  /** Short status-bubble text, e.g. "Running tests…" or "Proposing: update docs". */
  status: string
  /** Ephemeral FYI the observer surfaced via remark(); auto-clears after a few
   *  seconds. Separate from `status` (activity) — this is a one-off message. */
  remark: string
  /** The todo the executor is currently running, or null. */
  currentTodoId: string | null
  /** Canvas node id the avatar should hover near (active terminal), or null. */
  focusNodeId: string | null
}

export const DEFAULT_PET_WS: PetWsState = {
  enabled: false,
  paused: false,
  autoObserve: true,
  activity: 'off',
  status: '',
  remark: '',
  currentTodoId: null,
  focusNodeId: null,
}

interface PetStore {
  byWs: Record<string, PetWsState>
  get: (wsId: string) => PetWsState
  patch: (wsId: string, patch: Partial<PetWsState>) => void
  reset: (wsId: string) => void
}

export const usePetStore = create<PetStore>((set, getStore) => ({
  byWs: {},

  get(wsId) {
    return getStore().byWs[wsId] ?? DEFAULT_PET_WS
  },

  patch(wsId, patch) {
    set((s) => {
      const prev = s.byWs[wsId] ?? DEFAULT_PET_WS
      return { byWs: { ...s.byWs, [wsId]: { ...prev, ...patch } } }
    })
  },

  reset(wsId) {
    set((s) => ({ byWs: { ...s.byWs, [wsId]: { ...DEFAULT_PET_WS } } }))
  },
}))

/** Hook: subscribe to one workspace's pet state (stable default when absent). */
export function usePetWs(wsId: string | null | undefined): PetWsState {
  return usePetStore((s) => (wsId ? s.byWs[wsId] ?? DEFAULT_PET_WS : DEFAULT_PET_WS))
}
