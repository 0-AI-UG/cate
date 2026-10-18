// Pure analytics decisions: what to report after a launch, the one-time
// install census, and clamping what renderers send.

export interface AnalyticsState {
  lastSeenVersion?: string
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

type UpdateAction =
  | { kind: 'first_install'; emit: 'app_install'; nextState: AnalyticsState }
  | { kind: 'no_change'; nextState: AnalyticsState }
  | { kind: 'version_changed'; emit: 'app_updated'; from: string; to: string; nextState: AnalyticsState }

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
      nextState: { ...state, lastSeenVersion: current },
    }
  }

  if (previous === current) return { kind: 'no_change', nextState: state }

  return {
    kind: 'version_changed',
    emit: 'app_updated',
    from: previous,
    to: current,
    nextState: { ...state, lastSeenVersion: current },
  }
}
