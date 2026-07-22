// =============================================================================
// providerReadinessStore — the single source of truth, per renderer window, for
// "is an AI provider connected, and does it actually work?".
//
// Before this store, every consumer (the agent chat panel, the Cate Agent, the
// settings screens) called authStatus() on its own and interpreted the result
// differently — and none of them could tell "nothing connected" from "your
// sign-in expired". This store centralises both questions:
//
//   - connection (presence): authStatus() — cheap, refreshed on AUTH_CHANGED.
//   - health (does it work): authVerify() — an OAuth token refresh or one live
//     model request; cached per provider, dropped when credentials change.
//
// Consumers read via the hooks at the bottom. The store self-starts on first use
// (ensureStarted), so no window shell needs special wiring.
// =============================================================================

import { useEffect } from 'react'
import { create } from 'zustand'
import type { CateAgentModelRef, AuthProviderStatus, ProviderVerification } from '../../shared/types'
import { useSettingsStore } from './settingsStore'
import log from '../lib/logger'

/** What a consumer should show for a given selected model. */
export type ReadinessKind = 'loading' | 'noProvider' | 'noModel' | 'needsReauth' | 'error' | 'ok'

export interface CodingReadiness {
  kind: ReadinessKind
  /** Provider whose health is in question (for needsReauth / error). */
  providerId?: string
  /** Failure detail from verification, if any. */
  error?: string
  /** Ready-to-render one-line explanation. */
  message: string
}

interface ProviderReadinessStore {
  statuses: AuthProviderStatus[]
  /** Verification results keyed by providerId. Dropped on credential change. */
  verifications: Record<string, ProviderVerification>
  loaded: boolean
  /** Bumped on every AUTH_CHANGED so health effects can re-verify. */
  authNonce: number

  ensureStarted: () => void
  refresh: () => Promise<void>
  verify: (providerId: string) => Promise<void>
}

// Module-level: the AUTH_CHANGED subscription + first fetch happen once per window.
let started = false
let refreshPending: Promise<void> | null = null
const verificationPending = new Map<string, Promise<void>>()

export const useProviderReadinessStore = create<ProviderReadinessStore>((set, get) => ({
  statuses: [],
  verifications: {},
  loaded: false,
  authNonce: 0,

  ensureStarted() {
    if (started) return
    started = true
    void get().refresh()
    if (typeof window !== 'undefined' && window.electronAPI?.onAuthChanged) {
      window.electronAPI.onAuthChanged(() => {
        // Credentials changed anywhere — presence may differ and any cached
        // health is now stale.
        set((s) => ({ verifications: {}, authNonce: s.authNonce + 1 }))
        void get().refresh()
      })
    }
  },

  async refresh() {
    if (refreshPending) return refreshPending
    refreshPending = (async () => {
      try {
        const statuses = await window.electronAPI.authStatus()
        set({ statuses, loaded: true })
      } catch (err) {
        log.warn('[providerReadiness] authStatus failed', err)
        set({ loaded: true })
      } finally {
        refreshPending = null
      }
    })()
    return refreshPending
  },

  async verify(providerId) {
    const pending = verificationPending.get(providerId)
    if (pending) return pending
    const request = (async () => {
      try {
        const result = await window.electronAPI.authVerify(providerId)
        set((s) => ({ verifications: { ...s.verifications, [providerId]: result } }))
      } catch (err) {
        log.warn('[providerReadiness] authVerify failed for %s', providerId, err)
      } finally {
        verificationPending.delete(providerId)
      }
    })()
    verificationPending.set(providerId, request)
    return request
  },
}))

// -----------------------------------------------------------------------------
// Hooks
// -----------------------------------------------------------------------------

/** Whether the first authStatus() has resolved (avoid flashing "no provider"
 *  before we know). */
export function useProvidersLoaded(): boolean {
  useEnsureStarted()
  return useProviderReadinessStore((s) => s.loaded)
}

/** The rich per-consumer readiness for a selected model. Triggers a live
 *  verification of that model's provider and reflects the result. */
export function useCodingReadiness(model: CateAgentModelRef | null): CodingReadiness {
  useEnsureStarted()
  const loaded = useProviderReadinessStore((s) => s.loaded)
  const anyConnected = useProviderReadinessStore((s) => s.statuses.some((p) => p.connected))
  const providerConnected = useProviderReadinessStore(
    (s) => !!model && s.statuses.some((p) => p.id === model.provider && p.connected),
  )
  const verification = useProviderReadinessStore((s) =>
    model ? s.verifications[model.provider] : undefined,
  )
  const authNonce = useProviderReadinessStore((s) => s.authNonce)
  const verify = useProviderReadinessStore((s) => s.verify)

  // Verify the selected provider on mount, when the pick changes, and after any
  // credential change (authNonce) — this refreshes its OAuth token and surfaces
  // an expired sign-in. No-op if the provider isn't connected.
  useEffect(() => {
    if (!model || !providerConnected) return
    void verify(model.provider)
    // Depend on the provider id, not the model object — its identity can change
    // every render (callers derive it per-render), which would re-verify each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model?.provider, providerConnected, authNonce, verify])

  return deriveReadiness(loaded, anyConnected, !!model, providerConnected, model?.provider, verification)
}

function useEnsureStarted(): void {
  const ensureStarted = useProviderReadinessStore((s) => s.ensureStarted)
  useEffect(() => { ensureStarted() }, [ensureStarted])
}

// -----------------------------------------------------------------------------
// Cate Agent gate
// -----------------------------------------------------------------------------

/** Whether the Cate Agent can run right now. Unlike the agent panel (which lets
 *  the user pick + reconnect per chat), the Cate Agent is headless and hides
 *  entirely unless a usable provider exists — a connected-but-expired OAuth
 *  sign-in counts as unusable (`needsReauth`), same as no provider at all. */
export type CateAgentGate = 'ok' | 'noProvider' | 'needsReauth'

function normalizeModel(value: CateAgentModelRef | null | undefined): CateAgentModelRef | null {
  return value && typeof value.provider === 'string' && typeof value.model === 'string'
    ? { provider: value.provider, model: value.model }
    : null
}

/** Gate for a specific effective model. Verifies the relevant provider(s) so an
 *  expired OAuth token flips the gate to `needsReauth`. Optimistic: an unverified
 *  provider counts as usable, so nothing flashes hidden while a probe is in flight. */
export function useCateAgentGate(preferredModel: CateAgentModelRef | null): CateAgentGate {
  useEnsureStarted()
  const loaded = useProviderReadinessStore((s) => s.loaded)
  const connectedIds = useProviderReadinessStore((s) =>
    s.statuses.filter((p) => p.connected).map((p) => p.id).join(','),
  )
  const verifications = useProviderReadinessStore((s) => s.verifications)
  const authNonce = useProviderReadinessStore((s) => s.authNonce)
  const verify = useProviderReadinessStore((s) => s.verify)

  const connected = connectedIds ? connectedIds.split(',') : []
  const preferId = preferredModel?.provider
  // When the configured model's provider is connected, only IT matters (the agent
  // will use it). Otherwise any connected provider can back the auto-pick.
  const candidates = preferId && connected.includes(preferId) ? [preferId] : connected
  const candidateKey = candidates.join(',')

  useEffect(() => {
    for (const id of candidateKey ? candidateKey.split(',') : []) void verify(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateKey, authNonce, verify])

  return deriveCateAgentGate(loaded, connected, verifications, preferId)
}

/** Pure gate decision (exported for tests). Optimistic: an unverified provider
 *  counts as usable, so nothing flashes hidden while a probe is in flight. */
export function deriveCateAgentGate(
  loaded: boolean,
  connectedIds: string[],
  verifications: Record<string, ProviderVerification>,
  preferredProvider: string | undefined,
): CateAgentGate {
  if (!loaded) return 'ok' // optimistic until the first status resolves
  if (connectedIds.length === 0) return 'noProvider'
  const candidates =
    preferredProvider && connectedIds.includes(preferredProvider) ? [preferredProvider] : connectedIds
  const broken = (id: string): boolean => {
    const health = verifications[id]?.health
    return health === 'needsReauth' || health === 'error'
  }
  return candidates.some((id) => !broken(id)) ? 'ok' : 'needsReauth'
}

/** The gate for the Cate Agent, keyed on the shared default model (Settings →
 *  Providers). Per-chat model overrides don't affect readiness — this only asks
 *  whether some usable provider is connected. Reactive to the default key. */
export function useCateAgentReady(): CateAgentGate {
  const defaultModel = useSettingsStore((s) => s.agentDefaultModel)
  return useCateAgentGate(normalizeModel(defaultModel))
}

/** Pure mapping from state → what to show. Exported for tests. Optimistic: a
 *  connected provider reads as `ok` until a verification actively says otherwise,
 *  so the composer isn't blocked while a probe is in flight. */
export function deriveReadiness(
  loaded: boolean,
  anyConnected: boolean,
  hasModel: boolean,
  providerConnected: boolean,
  providerId: string | undefined,
  verification: ProviderVerification | undefined,
): CodingReadiness {
  if (!loaded) return { kind: 'loading', message: '' }
  if (!anyConnected) {
    return { kind: 'noProvider', message: 'No AI provider is connected.' }
  }
  if (!hasModel || !providerConnected) {
    return { kind: 'noModel', message: 'No model selected.' }
  }
  if (verification?.health === 'needsReauth') {
    return {
      kind: 'needsReauth',
      providerId,
      error: verification.error,
      message: `Your ${providerId ?? 'provider'} sign-in has expired. Reconnect to keep using the agent.`,
    }
  }
  if (verification?.health === 'error') {
    return {
      kind: 'error',
      providerId,
      error: verification.error,
      message: `Couldn't reach ${providerId ?? 'the provider'}${verification.error ? `: ${verification.error}` : '.'}`,
    }
  }
  return { kind: 'ok', providerId, message: '' }
}
