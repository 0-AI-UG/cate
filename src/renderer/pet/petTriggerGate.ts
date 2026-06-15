// =============================================================================
// petTriggerGate — the pure decision for whether the observer should take a turn.
//
// The observer is event-driven but rate-limited: activity marks the workspace
// `dirty`; an interval tick asks this gate whether to actually spend an observe
// turn. Kept pure (no timers, no stores) so the policy is unit-testable and the
// controller just feeds it the current facts.
// =============================================================================

export interface TriggerGateInput {
  enabled: boolean
  paused: boolean
  /** Whether automatic observe turns are allowed. When false, only a manual
   *  nudge (clicking the idle pet) observes — the timer never fires. */
  autoObserve: boolean
  /** Something changed since the last observe turn (save/git/terminal/todo). */
  dirty: boolean
  /** An observer turn is already in flight. */
  observerBusy: boolean
  /** The executor is running a todo (don't distract with proposals mid-run). */
  executorBusy: boolean
  /** Count of suggestions awaiting the user (suggested status). */
  openSuggestions: number
  /** ms timestamp of the last observe turn (0 if never). */
  lastObserveAt: number
  /** ms now. */
  now: number
}

/** Minimum gap between observe turns, even when dirty. */
export const OBSERVE_COOLDOWN_MS = 60_000
/** Cap on outstanding suggestions; above this the observer stays quiet. */
export const MAX_OPEN_SUGGESTIONS = 3

export function shouldObserve(input: TriggerGateInput): boolean {
  if (!input.enabled || input.paused) return false
  if (!input.autoObserve) return false
  if (!input.dirty) return false
  if (input.observerBusy || input.executorBusy) return false
  if (input.openSuggestions >= MAX_OPEN_SUGGESTIONS) return false
  if (input.now - input.lastObserveAt < OBSERVE_COOLDOWN_MS) return false
  return true
}
