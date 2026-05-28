// =============================================================================
// Agent activity coordinator.
//
// Agent running-state is derived from the agent CLI's own OSC window title:
// while a turn is in flight the title animates a braille spinner, and it drops
// to a static marker when idle (see agentSpinner). This is an explicit signal
// the agent emits — no byte-rate or subprocess heuristics.
//
// Three event sources feed the per-terminal state machine:
//   - title changes      (noteAgentTitle)      → spinner in the title (claude/codex)
//   - body spinner frames (noteAgentSpinnerByte)→ braille animating in the body (pi)
//   - agent presence      (noteAgentPresence)   → notRunning / finished, from main's
//                                                  process-tree scan
//
// "running" = a spinner is animating in the title OR the body. A per-terminal
// settle timer (WAITING_SETTLE_MS) bridges the gap between spinner frames so a
// momentary idle doesn't flicker the UI, and gates the "needs input"
// notification so it only fires after a turn genuinely ends. The settle timer
// is armed once when the agent first looks idle and is only cleared when it
// stops looking idle — it is NOT re-armed on every observation, so the 1 Hz
// presence poll can't keep resetting it.
// =============================================================================

import { useStatusStore } from '../stores/statusStore'
import { sendOsNotification } from './osNotificationSend'
import { resolveAgentState, WAITING_SETTLE_MS, BODY_SPINNER_TIMEOUT_MS } from './agentScreenDetectorLogic'
import type { AgentState } from '../../shared/types'

interface Tracker {
  present: boolean
  wasPresent: boolean
  titleSpinner: boolean
  bodySpinner: boolean
  state: AgentState
  agentName: string | null
  /** Pending running→waitingForInput settle, or null when not counting down. */
  settleTimer: ReturnType<typeof setTimeout> | null
  /** Expiry for the body spinner — refreshed on each braille frame. */
  bodyTimer: ReturnType<typeof setTimeout> | null
}

const trackers = new Map<string, Tracker>()
let started = false

function trackerFor(terminalId: string): Tracker {
  let t = trackers.get(terminalId)
  if (!t) {
    t = {
      present: false,
      wasPresent: false,
      titleSpinner: false,
      bodySpinner: false,
      state: 'notRunning',
      agentName: null,
      settleTimer: null,
      bodyTimer: null,
    }
    trackers.set(terminalId, t)
  }
  return t
}

function clearSettle(t: Tracker): void {
  if (t.settleTimer) {
    clearTimeout(t.settleTimer)
    t.settleTimer = null
  }
}

function clearTimers(t: Tracker): void {
  clearSettle(t)
  if (t.bodyTimer) {
    clearTimeout(t.bodyTimer)
    t.bodyTimer = null
  }
}

function workspaceFor(terminalId: string): string | undefined {
  return useStatusStore.getState().terminalWorkspaceMap[terminalId]
}

/** Apply a resolved state to the store + mirror it to other windows. `notify`
 *  fires the OS "needs input" notification; only the settle timer passes true. */
function commit(terminalId: string, state: AgentState, notify: boolean): void {
  const t = trackers.get(terminalId)
  if (!t || t.state === state) return
  const workspaceId = workspaceFor(terminalId)
  if (!workspaceId) return

  t.state = state
  const status = useStatusStore.getState()
  status.setAgentState(workspaceId, terminalId, state, t.agentName)
  window.electronAPI?.shellReportAgentScreenState?.(terminalId, state)

  if (notify && state === 'waitingForInput') {
    const displayName = t.agentName ?? 'Agent'
    sendOsNotification({
      title: `${displayName} needs input`,
      body: `${displayName} is waiting for your response.`,
      action: { type: 'focusTerminal', workspaceId, terminalId },
    })
  }
}

function recompute(terminalId: string): void {
  const t = trackers.get(terminalId)
  if (!t || !started) return

  const raw = resolveAgentState({
    present: t.present,
    wasPresent: t.wasPresent,
    spinning: t.titleSpinner || t.bodySpinner,
  })

  if (raw === 'waitingForInput') {
    if (t.state === 'running') {
      // A turn just ended. Hold the running state through the settle window so
      // a one-frame idle title (between spinner frames / tool round-trips)
      // doesn't flicker; only fire once it stays parked. Arm once — don't reset
      // on every observation, or the 1 Hz presence poll would never let it fire.
      if (!t.settleTimer) {
        t.settleTimer = setTimeout(() => {
          t.settleTimer = null
          commit(terminalId, 'waitingForInput', true)
        }, WAITING_SETTLE_MS)
      }
    } else {
      // Fresh-launch idle (notRunning → waiting) or already waiting: reflect it
      // in the UI but do NOT notify — the agent never started a turn.
      clearSettle(t)
      commit(terminalId, 'waitingForInput', false)
    }
    return
  }

  // running / finished / notRunning are all immediate and never notify here
  // (agent exit is intentional, so 'finished' is silent).
  clearSettle(t)
  commit(terminalId, raw, false)
}

/** Title changed for a terminal — `running` is the spinner classification. */
export function noteAgentTitle(terminalId: string, running: boolean): void {
  const t = trackerFor(terminalId)
  t.titleSpinner = running
  recompute(terminalId)
}

/** A braille spinner frame was seen in the terminal body (e.g. pi's
 *  "⠋ Working…" line). Marks the agent running until the frames stop. */
export function noteAgentSpinnerByte(terminalId: string): void {
  const t = trackerFor(terminalId)
  t.bodySpinner = true
  if (t.bodyTimer) clearTimeout(t.bodyTimer)
  t.bodyTimer = setTimeout(() => {
    t.bodyTimer = null
    t.bodySpinner = false
    recompute(terminalId)
  }, BODY_SPINNER_TIMEOUT_MS)
  recompute(terminalId)
}

/** Main's process scan reported whether the agent CLI is present. */
export function noteAgentPresence(
  terminalId: string,
  present: boolean,
  agentName: string | null,
): void {
  const t = trackerFor(terminalId)
  if (agentName != null) t.agentName = agentName
  t.wasPresent = t.present
  t.present = present
  recompute(terminalId)
}

/** Drop a terminal's tracker (wire into statusStore.unregisterTerminal). */
export function forgetAgentTracker(terminalId: string): void {
  const t = trackers.get(terminalId)
  if (t) clearTimers(t)
  trackers.delete(terminalId)
}

export function startAgentScreenDetector(): void {
  started = true
}

export function stopAgentScreenDetector(): void {
  started = false
  for (const t of trackers.values()) clearTimers(t)
  trackers.clear()
}

export function applyRemoteAgentScreenState(terminalId: string, state: AgentState): void {
  const status = useStatusStore.getState()
  const workspaceId = status.terminalWorkspaceMap[terminalId]
  if (!workspaceId) return
  const agentName = status.workspaces[workspaceId]?.agentName[terminalId] ?? null
  status.setAgentState(workspaceId, terminalId, state, agentName)
}
