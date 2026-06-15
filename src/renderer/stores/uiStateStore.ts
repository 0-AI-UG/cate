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
import { getElectronAPI, mergeKnown } from './jsonProjection'

interface ElectronUIStateAPI {
  uiStateGetAll: () => Promise<Partial<UIState>>
  uiStateSet: (key: string, value: unknown) => Promise<void>
}

function getAPI(): ElectronUIStateAPI | null {
  return getElectronAPI<ElectronUIStateAPI>()
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
      set({ ...mergeKnown(DEFAULT_UI_STATE, stored), _loaded: true })
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
