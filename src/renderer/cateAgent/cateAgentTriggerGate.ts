// =============================================================================
// cateAgentTriggerGate — the pure decision for whether the observer should take a turn.
//
// The observer is event-driven but rate-limited: activity marks the workspace
// `dirty`; an interval tick asks this gate whether to actually spend an observe
// turn. Kept pure (no timers, no stores) so the policy is unit-testable and the
// controller just feeds it the current facts.
// =============================================================================

export interface TriggerGateInput {
  /** Whether automatic observe turns are allowed. When false, only a manual
   *  nudge (clicking the idle Cate Agent) observes — the timer never fires. */
  autoObserve: boolean
  /** Something changed since the last observe turn (save/git/terminal/todo). */
  dirty: boolean
  /** An observer turn is already in flight. */
  observerBusy: boolean
  /** The orchestrator is running a todo (don't distract with proposals mid-run). */
  orchestratorBusy: boolean
  /** Count of suggestions awaiting the user (suggested status). */
  openSuggestions: number
  /** ms timestamp of the last observe turn (0 if never). */
  lastObserveAt: number
  /** ms now. */
  now: number
  /** Minimum gap between observe turns, even when dirty (Settings → Cate Agent,
   *  "Observation frequency"). */
  cooldownMs: number
}

/** Cap on outstanding suggestions; above this the observer stays quiet. */
export const MAX_OPEN_SUGGESTIONS = 3

export function shouldObserve(input: TriggerGateInput): boolean {
  if (!input.autoObserve) return false
  if (!input.dirty) return false
  if (input.observerBusy || input.orchestratorBusy) return false
  if (input.openSuggestions >= MAX_OPEN_SUGGESTIONS) return false
  if (input.now - input.lastObserveAt < input.cooldownMs) return false
  return true
}
