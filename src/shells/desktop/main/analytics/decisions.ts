// Pure analytics decisions: what to report after a launch, the one-time
// install census, and clamping what renderers send.

export interface AnalyticsState {
  lastSeenVersion?: string
  /** Show the post-update changelog and feedback dialog once for this version. */
  pendingFeedbackForVersion?: string
  pendingFeedbackFromVersion?: string
  /** The one-time install census was sent. */
  censusSent?: boolean
}

/** Keep only a few small primitive props (string/number/boolean), with strings
 *  clamped short: defends the usage channel against free-form text or paths
 *  riding along in props. Exported for tests. */
export function sanitizeUsageProps(raw: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  if (!raw || typeof raw !== 'object') return out
  let n = 0
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= 6) break
    if (typeof v === 'string') out[k.slice(0, 32)] = v.slice(0, 48)
    else if (typeof v === 'number' || typeof v === 'boolean') out[k.slice(0, 32)] = v
    else continue
    n++
  }
  return out
}

/** Clamp + truncate raw IPC payload from the renderer. Exported for tests. */
export function sanitizeFeedbackPayload(payload: unknown): { rating: number; comment: string } {
  const p = (payload ?? {}) as { rating?: unknown; comment?: unknown }
  const rating = Math.max(1, Math.min(5, Math.round(Number(p.rating) || 0)))
  const comment = typeof p.comment === 'string' ? p.comment.slice(0, 1000) : ''
  return { rating, comment }
}

type UpdateAction =
  // First install emits app_install but does NOT queue a feedback prompt: the
  // onboarding tour is the first-run welcome, so the changelog/feedback dialog would
  // overlap it. The dialog is for updates only.
  | { kind: 'first_install'; emit: 'app_install'; nextState: AnalyticsState }
  | { kind: 'no_change'; nextState: AnalyticsState; prompt?: { from: string; to: string } }
  | {
      kind: 'version_changed'
      emit: 'app_updated'
      from: string
      to: string
      nextState: AnalyticsState
      prompt?: { from: string; to: string }
    }

// ---------------------------------------------------------------------------
// Install census: one-time backfill of installs that existed under an earlier
// opt-in build but never sent telemetry. Such an install has a recorded
// `lastSeenVersion` (checkAndReportUpdate wrote it even when sends were gated
// off) yet no install-id file (the id is written only inside the send path).
// We emit a single `app_install_backfill` so the backend can count it as a
// recovered install. Genuinely-new installs have no lastSeenVersion; installs
// that already sent telemetry had their install-id file pre-exist: neither
// qualifies, so this can't double-count. Pure for unit testing.
// ---------------------------------------------------------------------------

export type CensusAction =
  | { kind: 'none' }
  | { kind: 'backfill'; fromVersion: string; nextState: AnalyticsState }

export function decideCensusAction(state: AnalyticsState, installIdPreexistedFlag: boolean): CensusAction {
  if (state.censusSent) return { kind: 'none' }
  // Already counted: a pre-existing install-id means telemetry was sent before.
  if (installIdPreexistedFlag) return { kind: 'none' }
  // Brand-new install: nothing to backfill (a normal app_install covers it).
  if (!state.lastSeenVersion) return { kind: 'none' }
  return {
    kind: 'backfill',
    fromVersion: state.lastSeenVersion,
    nextState: { ...state, censusSent: true },
  }
}

export function decideUpdateAction(current: string, state: AnalyticsState): UpdateAction {
  const previous = state.lastSeenVersion

  if (!previous) {
    return {
      kind: 'first_install',
      emit: 'app_install',
      // No pendingFeedback*: the first-run welcome is the onboarding tour, so we
      // never surface the changelog/feedback dialog on a brand-new install.
      nextState: { ...state, lastSeenVersion: current },
    }
  }

  if (previous === current) {
    const action: UpdateAction = { kind: 'no_change', nextState: state }
    // Re-prompt if a previous launch queued feedback but the user killed the
    // app before answering. The pending flag is cleared on submit/dismiss.
    if (state.pendingFeedbackForVersion === current) {
      action.prompt = { from: state.pendingFeedbackFromVersion ?? previous, to: current }
    }
    return action
  }

  return {
    kind: 'version_changed',
    emit: 'app_updated',
    from: previous,
    to: current,
    nextState: {
      ...state,
      lastSeenVersion: current,
      pendingFeedbackForVersion: current,
      pendingFeedbackFromVersion: previous,
    },
    prompt: { from: previous, to: current },
  }
}
