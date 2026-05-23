import type { AgentState } from '../../shared/types'

export const POLL_MS = 250
export const RUNNING_HOLD_MS = 3000
export const NEVER = -1e9

export interface DetectorSignals {
  agentPresent: boolean
  wasAgentPresent: boolean
  subprocessActive: boolean
}

export interface HysteresisState {
  lastReported: AgentState | null
  pendingWaitingSince: number | null
}

export function computeRawState(s: DetectorSignals): AgentState {
  if (!s.agentPresent && s.wasAgentPresent) return 'finished'
  if (!s.agentPresent) return 'notRunning'
  if (s.subprocessActive) return 'running'
  return 'waitingForInput'
}

export function applyHysteresis(
  rawState: AgentState,
  h: HysteresisState,
  now: number,
): AgentState {
  if (rawState === 'running') {
    h.pendingWaitingSince = null
    return 'running'
  }
  if (rawState === 'finished' || rawState === 'notRunning') {
    h.pendingWaitingSince = null
    return rawState
  }
  if (h.lastReported === 'running') {
    if (h.pendingWaitingSince === null) h.pendingWaitingSince = now
    if (now - h.pendingWaitingSince >= RUNNING_HOLD_MS) {
      h.pendingWaitingSince = null
      return 'waitingForInput'
    }
    return 'running'
  }
  h.pendingWaitingSince = null
  return rawState
}
