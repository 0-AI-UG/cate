// =============================================================================
// workspaceTrustStore — which projects the user has trusted to auto-restore
// process-bearing panels, plus the per-workspace "we withheld this" notices the
// trust banner renders.
//
// The authoritative list lives in the main process (userData/trusted-projects.json,
// see main/workspaceStateStore.ts). This store is a renderer-side mirror, hydrated
// once at startup, because the restore path is synchronous-ish and must not race
// an IPC round-trip per workspace. Trust decisions write through to main.
//
// Deliberately NOT persisted per project: the whole point is that the project
// cannot influence its own trust state (GHSA-8769-jp52-985f).
// =============================================================================

import { create } from 'zustand'
import log from '../lib/logger'
import type { WithheldSummary } from '../lib/workspace/sessionTrustFilter'

interface WorkspaceTrustState {
  /** Locators the user has explicitly trusted. Mirrors main. */
  trusted: string[]
  /** Whether the mirror has been hydrated from main yet. */
  hydrated: boolean
  /** Pending banners, keyed by workspace id, for layouts we filtered. */
  withheld: Record<string, { locator: string; summary: WithheldSummary }>
  /** Notices filed before a workspace id existed (startup load runs before
   *  workspaces are created), keyed by locator and adopted in `adoptPending`. */
  pendingByLocator: Record<string, WithheldSummary>
}

interface WorkspaceTrustActions {
  hydrate: () => Promise<void>
  isTrusted: (locator: string | undefined | null) => boolean
  /** Record a trust decision and write it through to main. */
  setTrusted: (locator: string, trusted: boolean) => Promise<void>
  noteWithheld: (workspaceId: string, locator: string, summary: WithheldSummary) => void
  /** File a notice before the workspace exists (startup load). */
  notePending: (locator: string, summary: WithheldSummary) => void
  /** Bind any pending notice for `locator` to a now-created workspace. */
  adoptPending: (workspaceId: string, locator: string | undefined | null) => void
  clearWithheld: (workspaceId: string) => void
}

export const useWorkspaceTrustStore = create<WorkspaceTrustState & WorkspaceTrustActions>((set, get) => ({
  trusted: [],
  hydrated: false,
  withheld: {},
  pendingByLocator: {},

  hydrate: async () => {
    try {
      const trusted = (await window.electronAPI.projectTrustGet()) ?? []
      set({ trusted, hydrated: true })
    } catch (err) {
      // Fail CLOSED: an unreadable trust list means nothing is trusted, so
      // layouts restore passive-only rather than silently regaining auto-start.
      log.warn('[trust] failed to load trusted projects — treating all as untrusted: %s', err)
      set({ trusted: [], hydrated: true })
    }
  },

  isTrusted: (locator) => !!locator && get().trusted.includes(locator),

  setTrusted: async (locator, trusted) => {
    // Update the mirror first so the caller can restore immediately.
    set((s) => ({
      trusted: trusted ? [...s.trusted.filter((p) => p !== locator), locator] : s.trusted.filter((p) => p !== locator),
    }))
    try {
      const next = (await window.electronAPI.projectTrustSet(locator, trusted)) ?? []
      set({ trusted: next })
    } catch (err) {
      log.warn('[trust] failed to persist trust for %s: %s', locator, err)
    }
  },

  noteWithheld: (workspaceId, locator, summary) => {
    if (summary.total === 0) return
    set((s) => ({ withheld: { ...s.withheld, [workspaceId]: { locator, summary } } }))
  },

  notePending: (locator, summary) => {
    if (summary.total === 0 || !locator) return
    set((s) => ({ pendingByLocator: { ...s.pendingByLocator, [locator]: summary } }))
  },

  adoptPending: (workspaceId, locator) => {
    if (!locator) return
    set((s) => {
      const summary = s.pendingByLocator[locator]
      if (!summary) return s
      const pendingByLocator = { ...s.pendingByLocator }
      delete pendingByLocator[locator]
      return {
        pendingByLocator,
        withheld: { ...s.withheld, [workspaceId]: { locator, summary } },
      }
    })
  },

  clearWithheld: (workspaceId) => {
    set((s) => {
      if (!s.withheld[workspaceId]) return s
      const next = { ...s.withheld }
      delete next[workspaceId]
      return { withheld: next }
    })
  },
}))

/** Non-hook accessor for the restore path (which runs outside React). */
export function isProjectTrusted(locator: string | undefined | null): boolean {
  return useWorkspaceTrustStore.getState().isTrusted(locator)
}
