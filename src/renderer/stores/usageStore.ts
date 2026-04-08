// =============================================================================
// Usage Store — Zustand state for token usage tracking across all agent CLIs.
// =============================================================================

import { create } from 'zustand'
import type { UsageSummary, ProjectUsage } from '../../shared/types'

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface UsageStoreState {
  summary: UsageSummary | null
  loading: boolean
  lastUpdated: number
}

interface UsageStoreActions {
  loadSummary: () => Promise<void>
  /** Load once if not already loaded. Safe to call multiple times. */
  ensureLoaded: () => Promise<void>
  /** Subscribe to live updates (no initial load). Returns cleanup fn. */
  init: () => () => void
}

export type UsageStore = UsageStoreState & UsageStoreActions

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

export const useUsageStore = create<UsageStore>((set, _get) => ({
  // --- State ---
  summary: null,
  loading: false,
  lastUpdated: 0,

  // --- Actions ---

  async loadSummary() {
    set({ loading: true })
    try {
      const summary = await window.electronAPI.usageGetSummary()
      set({ summary, loading: false, lastUpdated: Date.now() })
    } catch {
      set({ loading: false })
    }
  },

  async ensureLoaded() {
    const s = useUsageStore.getState()
    if (s.summary || s.loading) return
    await s.loadSummary()
  },

  init() {
    // Subscribe only — the initial load is explicit (ensureLoaded), so startup
    // isn't blocked by the main-process usage scan.
    // Subscribe to live updates with ~300ms debounce
    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    const unsubscribe = window.electronAPI.onUsageUpdate(() => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        useUsageStore.getState().loadSummary()
      }, 300)
    })

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      unsubscribe()
    }
  },
}))

// -----------------------------------------------------------------------------
// Selector helpers
// -----------------------------------------------------------------------------

/**
 * Returns the ProjectUsage for a given project path, or null if not found.
 * Uses zustand selector for stable reference — only re-renders when the specific
 * project entry changes.
 */
export function useProjectUsage(projectPath: string | undefined): ProjectUsage | null {
  return useUsageStore((state) => {
    if (!projectPath || !state.summary) return null
    return state.summary.projects.find((p) => p.projectPath === projectPath) ?? null
  })
}
