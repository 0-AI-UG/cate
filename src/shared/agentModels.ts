import type { CateAgentModelRef } from './types'

/** Resolve the model used for a new session.
 *
 * Explicit per-chat choices are strict. Automatic/default selection validates
 * the persisted preference against the live catalog, then falls back to the
 * catalog's deterministic first entry. */
export function resolveEffectiveAgentModel(
  explicit: CateAgentModelRef | null | undefined,
  configuredDefault: CateAgentModelRef | null | undefined,
  available: readonly CateAgentModelRef[],
): CateAgentModelRef | null {
  if (explicit) return explicit
  if (
    configuredDefault &&
    available.some(
      (candidate) =>
        candidate.provider === configuredDefault.provider &&
        candidate.model === configuredDefault.model,
    )
  ) {
    return configuredDefault
  }
  return available[0] ?? null
}
