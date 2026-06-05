// =============================================================================
// UI State Store — Zustand mirror of <userData>/ui-state.json (minimap
// placement). Transient, cosmetic, per-machine UI state; kept out of
// settings.json. Loaded once on launch; single keys are written back fire-and-
// forget through IPC (main debounces the disk write).
// =============================================================================

import { create } from 'zustand'
import log from '../lib/logger'
import type { UIState } from '../../shared/types'
import { DEFAULT_UI_STATE } from '../../shared/types'

interface ElectronUIStateAPI {
  uiStateGetAll: () => Promise<Partial<UIState>>
  uiStateSet: (key: string, value: unknown) => Promise<void>
}

function getAPI(): ElectronUIStateAPI | null {
  const api = typeof window !== 'undefined' ? (window as unknown as Record<string, unknown>).electronAPI : null
  return (api as ElectronUIStateAPI) ?? null
}

interface UIStateStore extends UIState {
  _loaded: boolean
  loadUIState: () => Promise<void>
  setUIState: <K extends keyof UIState>(key: K, value: UIState[K]) => void
}

export const useUIStateStore = create<UIStateStore>((set) => ({
  ...DEFAULT_UI_STATE,
  _loaded: false,

  async loadUIState() {
    const api = getAPI()
    if (!api) { set({ _loaded: true }); return }
    try {
      const stored = await api.uiStateGetAll()
      const merged: Partial<UIState> = {}
      for (const key of Object.keys(DEFAULT_UI_STATE) as (keyof UIState)[]) {
        if (key in stored && stored[key] !== undefined) (merged as Record<string, unknown>)[key] = stored[key]
      }
      set({ ...merged, _loaded: true })
    } catch {
      set({ _loaded: true })
    }
  },

  setUIState(key, value) {
    set({ [key]: value } as Partial<UIStateStore>)
    const api = getAPI()
    if (api) api.uiStateSet(key, value).catch((err) => log.warn('[uiState] save failed for %s:', key, err))
  },
}))
