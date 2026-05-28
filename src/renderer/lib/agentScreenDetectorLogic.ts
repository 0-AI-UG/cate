import type { AgentState } from '../../shared/types'

/** How long an agent must stay idle (no spinner in its title) after finishing
 *  a turn before we flip the UI to `waitingForInput` and fire the "needs
 *  input" notification. Bridges the brief gap between spinner frames / tool
 *  round-trips so a momentary idle title doesn't cause a flicker or a false
 *  ping. */
export const WAITING_SETTLE_MS = 1500

/** How long after the last braille frame in the body we still consider the
 *  agent to be spinning. Body spinners animate at ~10 Hz, so a gap this long
 *  means the spinner stopped. */
export const BODY_SPINNER_TIMEOUT_MS = 800

export interface DetectorSignals {
  /** Main's process-tree scan found the agent CLI for this terminal. */
  present: boolean
  /** The agent was present on the previous observation (for finished edge). */
  wasPresent: boolean
  /** A spinner is currently animating — in the title (claude/codex) or in the
   *  body (pi's "⠋ Working…" line). See agentSpinner. */
  spinning: boolean
}

export function resolveAgentState(s: DetectorSignals): AgentState {
  if (!s.present && s.wasPresent) return 'finished'
  if (!s.present) return 'notRunning'
  if (s.spinning) return 'running'
  return 'waitingForInput'
}
