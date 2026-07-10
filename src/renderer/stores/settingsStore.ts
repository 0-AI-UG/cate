// =============================================================================
// Settings Store — Zustand state for application settings.
// Ported from AppSettings.swift
// =============================================================================

import { create } from 'zustand'
import log from '../lib/logger'
import type { AppSettings } from '../../shared/types'
import { DEFAULT_SETTINGS } from '../../shared/types'
import { getElectronAPI as getAPI, loadOnce, mergeKnown } from './jsonProjection'

// -----------------------------------------------------------------------------
// Electron API type (exposed via preload)
// -----------------------------------------------------------------------------

interface ElectronSettingsAPI {
  settingsGet: (key: string) => Promise<unknown>
  settingsSet: (key: string, value: unknown) => Promise<void>
  settingsGetAll: () => Promise<Partial<AppSettings>>
  settingsReset: (key?: string) => Promise<void>
  settingsOpenInEditor?: () => Promise<string>
  onSettingsReloaded?: (callback: (settings: Partial<AppSettings>) => void) => () => void
}

// Copy only known AppSettings keys from a source object onto a target patch.
function pickKnownSettings(source: Partial<AppSettings>): Partial<AppSettings> {
  return mergeKnown(DEFAULT_SETTINGS, source)
}

// Subscribe once (per window) to SETTINGS_RELOADED. Main broadcasts the full
// settings through one funnel on EVERY change — UI-driven SETTINGS_SET/RESET,
// main-driven writes, and external hand-edits of settings.json — so this store
// is a pure projection of the authoritative main file and multi-window copies
// never drift. Guarded so repeat loadSettings() calls (e.g. in detached windows)
// don't stack listeners.
let reloadSubscribed = false

function getElectronAPI(): ElectronSettingsAPI | null {
  return getAPI<ElectronSettingsAPI>()
}

// -----------------------------------------------------------------------------
// Store interface
// -----------------------------------------------------------------------------

interface SettingsStoreState extends AppSettings {
  _loaded: boolean
}

interface SettingsStoreActions {
  setSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  resetSetting: (key: keyof AppSettings) => void
  resetAll: () => void
  loadSettings: () => Promise<void>
}

export type SettingsStore = SettingsStoreState & SettingsStoreActions

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

const loadSettingsOnce = loadOnce(async () => {
  const api = getElectronAPI()
  if (!api) {
    useSettingsStore.setState({ _loaded: true })
    return
  }

  try {
    const stored = await api.settingsGetAll()
    useSettingsStore.setState({ ...mergeKnown(DEFAULT_SETTINGS, stored), _loaded: true })
  } catch {
    useSettingsStore.setState({ _loaded: true })
  }

  if (!reloadSubscribed && api.onSettingsReloaded) {
    reloadSubscribed = true
    api.onSettingsReloaded((settings) => {
      useSettingsStore.setState(pickKnownSettings(settings))
    })
  }
})

export const useSettingsStore = create<SettingsStore>((set) => ({
  // --- State: all settings with defaults ---
  ...DEFAULT_SETTINGS,
  _loaded: false,

  // --- Actions ---

  setSetting(key, value) {
    set({ [key]: value } as Partial<SettingsStoreState>)
    // Fire-and-forget IPC save
    const api = getElectronAPI()
    if (api) {
      api.settingsSet(key, value).catch((err) => log.warn('[settings] Save failed for %s:', key, err))
    }
  },

  resetSetting(key) {
    const defaultValue = DEFAULT_SETTINGS[key]
    set({ [key]: defaultValue } as Partial<SettingsStoreState>)
    const api = getElectronAPI()
    if (api) {
      api.settingsReset(key).catch((err) => log.warn('[settings] Reset failed for %s:', key, err))
    }
  },

  resetAll() {
    set({ ...DEFAULT_SETTINGS })
    const api = getElectronAPI()
    if (api) {
      api.settingsReset().catch((err) => log.warn('[settings] Reset failed:', err))
    }
  },

  loadSettings: loadSettingsOnce,
}))
