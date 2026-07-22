// =============================================================================
// workspaceTrustStore — which projects the user has trusted to open.
//
// Trust is binary and it gates OPENING. A project is either trusted, in which
// case it opens normally with everything its layout asks for, or it is not
// opened at all. There is no restricted/partial mode: the user's two choices
// are "trust it and open it" and "don't open it".
//
// The authoritative list lives in the main process
// (userData/trusted-projects.json, see main/workspaceStateStore.ts). This store
// is a renderer-side mirror, hydrated once at startup, so the open path can
// answer without an IPC round-trip per workspace. Decisions write through.
//
// Deliberately NOT persisted per project: the whole point is that the project
// cannot influence its own trust state (GHSA-8769-jp52-985f).
// =============================================================================

import { create } from 'zustand'
import log from '../lib/logger'

/** One unanswered "do you trust this project?" question, waiting on the dialog. */
interface TrustPrompt {
  locator: string
  resolve: (trusted: boolean) => void
}

interface WorkspaceTrustState {
  /** Locators the user has explicitly trusted. Mirrors main. */
  trusted: string[]
  /** Whether the mirror has been hydrated from main yet. */
  hydrated: boolean
  /** FIFO of pending questions. Only the head is on screen; startup can enqueue
   *  one per project it wants to reopen and they are asked in turn. */
  queue: TrustPrompt[]
}

interface WorkspaceTrustActions {
  hydrate: () => Promise<void>
  isTrusted: (locator: string | undefined | null) => boolean
  /** Record a trust decision and write it through to main. */
  setTrusted: (locator: string, trusted: boolean) => Promise<void>
  /** Ask the user unless the project is already trusted. Resolves true when the
   *  project may be opened. */
  requestTrust: (locator: string | undefined | null) => Promise<boolean>
  /** The dialog's answer to the question at the head of the queue. */
  answerTrustPrompt: (trusted: boolean) => Promise<void>
}

export const useWorkspaceTrustStore = create<WorkspaceTrustState & WorkspaceTrustActions>((set, get) => ({
  trusted: [],
  hydrated: false,
  queue: [],

  hydrate: async () => {
    try {
      const trusted = (await window.electronAPI.projectTrustGet()) ?? []
      set({ trusted, hydrated: true })
    } catch (err) {
      // Fail CLOSED: an unreadable trust list means nothing is trusted, so every
      // project is re-asked rather than silently opened.
      log.warn('[trust] failed to load trusted projects — treating all as untrusted: %s', err)
      set({ trusted: [], hydrated: true })
    }
  },

  isTrusted: (locator) => !!locator && get().trusted.includes(locator),

  setTrusted: async (locator, trusted) => {
    // Update the mirror first so the caller can proceed immediately.
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

  requestTrust: (locator) => {
    if (!locator) return Promise.resolve(false)
    if (get().isTrusted(locator)) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      // Duplicates for the same locator are fine — two open paths racing on one
      // folder both ride the single question, because answering resolves every
      // queued entry for that locator at once.
      set((s) => ({ queue: [...s.queue, { locator, resolve }] }))
    })
  },

  answerTrustPrompt: async (trusted) => {
    const head = get().queue[0]
    if (!head) return
    if (trusted) await get().setTrusted(head.locator, true)
    const answered = get().queue.filter((p) => p.locator === head.locator)
    set((s) => ({ queue: s.queue.filter((p) => p.locator !== head.locator) }))
    for (const prompt of answered) prompt.resolve(trusted)
  },
}))

/** Non-hook accessor for paths that run outside React. */
export function isProjectTrusted(locator: string | undefined | null): boolean {
  return useWorkspaceTrustStore.getState().isTrusted(locator)
}

/**
 * The gate every open path goes through: resolves true when `locator` may be
 * opened, either because it is already trusted or because the user just said so
 * in the dialog. Resolves false when the user declined — the caller must then
 * not open the project, and must not read anything out of it.
 */
export function ensureProjectTrusted(locator: string | undefined | null): Promise<boolean> {
  return useWorkspaceTrustStore.getState().requestTrust(locator)
}
