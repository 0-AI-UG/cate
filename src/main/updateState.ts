// =============================================================================
// updateState — the "trapped user" detector, kept pure & electron-free so it
// unit-tests in isolation (the auto-updater that consumes it pulls in electron +
// electron-updater).
//
// The failure we guard against: a build downloads an update and stages it to
// install on quit, but the swap silently fails (Squirrel.Mac signature mismatch,
// translocation, a stray hard-exit). The app reopens on the SAME version and
// re-stages the same update forever — the user is trapped.
//
// We persist what we last staged (`pendingVersion`) and, on each launch, compare
// it to the version we actually came up on. If we did NOT advance, the install
// failed; after MAX_INSTALL_ATTEMPTS failures we stop trusting the auto path and
// route the user to the manual-reinstall fallback (see auto-updater.ts).
// =============================================================================

import { compareSemver } from './semver'

export interface UpdateRecord {
  /** Version we last downloaded and staged to install on quit, or null. */
  pendingVersion: string | null
  /** Consecutive launches where the staged install failed to apply. */
  attempts: number
}

export const DEFAULT_UPDATE_RECORD: UpdateRecord = { pendingVersion: null, attempts: 0 }

/** Failed install attempts tolerated before we give up on the auto path and
 *  surface the manual-reinstall prompt. Two = "it wasn't a one-off fluke." */
export const MAX_INSTALL_ATTEMPTS = 2

export type InstallDecision =
  /** No update was staged — nothing to evaluate. */
  | { kind: 'none'; nextRecord: UpdateRecord }
  /** We came up on the staged version (or newer) — the install worked. */
  | { kind: 'succeeded'; nextRecord: UpdateRecord }
  /** The staged install didn't apply, but we're still under the cap. */
  | { kind: 'retry'; nextRecord: UpdateRecord }
  /** Repeated failures — stop trusting auto-update, go manual. */
  | { kind: 'give-up-manual'; nextRecord: UpdateRecord }

/** Decide what the install-attempt record means on this launch. Pure: callers
 *  persist `nextRecord` and act on `kind`. */
export function decideInstallState(record: UpdateRecord, currentVersion: string): InstallDecision {
  if (!record.pendingVersion) {
    return { kind: 'none', nextRecord: DEFAULT_UPDATE_RECORD }
  }
  // Came up on the staged version or beyond → success; clear the record.
  if (compareSemver(currentVersion, record.pendingVersion) >= 0) {
    return { kind: 'succeeded', nextRecord: DEFAULT_UPDATE_RECORD }
  }
  // Still on the old version → the staged install failed to apply. Cap the
  // counter so the persisted record can't grow without bound across launches.
  const attempts = Math.min(record.attempts + 1, MAX_INSTALL_ATTEMPTS)
  const nextRecord: UpdateRecord = { pendingVersion: record.pendingVersion, attempts }
  if (attempts >= MAX_INSTALL_ATTEMPTS) {
    return { kind: 'give-up-manual', nextRecord }
  }
  return { kind: 'retry', nextRecord }
}

/** Validate raw parsed JSON into a complete UpdateRecord. Never throws — a
 *  malformed hand-edit degrades to defaults. Used by createJsonStateFile. */
export function normalizeUpdateRecord(parsed: unknown, defaults: UpdateRecord): UpdateRecord {
  if (typeof parsed !== 'object' || parsed === null) return defaults
  const raw = parsed as Record<string, unknown>
  const pendingVersion = typeof raw.pendingVersion === 'string' ? raw.pendingVersion : null
  const attempts =
    typeof raw.attempts === 'number' && Number.isFinite(raw.attempts) && raw.attempts > 0
      ? Math.floor(raw.attempts)
      : 0
  return { pendingVersion, attempts }
}
