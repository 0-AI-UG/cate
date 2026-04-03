// =============================================================================
// Settings Store — Zustand state for application settings.
// Ported from AppSettings.swift
// =============================================================================

import { create } from 'zustand'
import log from '../lib/logger'
import type { AppSettings } from '../../shared/types'
import { DEFAULT_SETTINGS } from '../../shared/types'

// -----------------------------------------------------------------------------
// Electron API type (exposed via preload)
// -----------------------------------------------------------------------------

interface ElectronSettingsAPI {
  settingsGet: (key: string) => Promise<unknown>
  settingsSet: (key: string, value: unknown) => Promise<void>
  settingsGetAll: () => Promise<Partial<AppSettings>>
  settingsReset: (key: string) => Promise<void>
}

function getElectronAPI(): ElectronSettingsAPI | null {
  if (
    typeof window !== 'undefined' &&
    (window as unknown as Record<string, unknown>).electronAPI
  ) {
    return (window as unknown as Record<string, unknown>).electronAPI as ElectronSettingsAPI
  }
  return null
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
  saveSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>
}

export type SettingsStore = SettingsStoreState & SettingsStoreActions

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

export const useSettingsStore = create<SettingsStore>((set, get) => ({
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
      // Reset each key individually via IPC
      for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
        api.settingsReset(key).catch((err) => log.warn('[settings] Reset failed for %s:', key, err))
      }
    }
  },

  async loadSettings() {
    const api = getElectronAPI()
    if (!api) {
      set({ _loaded: true })
      return
    }

    try {
      const stored = await api.settingsGetAll()
      // Merge stored values over defaults (only known keys)
      const merged: Partial<AppSettings> = {}
      for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
        if (key in stored && stored[key] !== undefined) {
          ;(merged as Record<string, unknown>)[key] = stored[key]
        }
      }
      set({ ...merged, _loaded: true })
    } catch {
      // Fall back to defaults on error
      set({ _loaded: true })
    }
  },

  async saveSetting(key, value) {
    set({ [key]: value } as Partial<SettingsStoreState>)
    const api = getElectronAPI()
    if (api) {
      await api.settingsSet(key, value)
    }
  },
}))
