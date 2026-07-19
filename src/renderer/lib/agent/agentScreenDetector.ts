// =============================================================================
// Agent activity coordinator.
//
// Running/idle for the hook-covered agents (claude/codex/pi/opencode) is driven
// by the normalized agent-hook event stream (SHELL_AGENT_HOOK_EVENT →
// noteAgentHookEvent): turn-start flips to 'running' immediately, turn-end
// flips back to 'waitingForInput' and fires the "needs input" notification,
// and session-end is treated like turn-end for state (the process may keep
// running after /clear). permission-wait (the CLI is blocked on tool approval)
// flips to 'waitingForInput' immediately with a "needs permission"
// notification whose body carries the blocked command; turn-resume (the
// approval ran the tool — also re-fired on every ordinary tool call) flips
// back to 'running' silently. The events are authoritative, so no settle
// timer is involved.
//
// cursor/agy have no usable hook coverage outside interactive turns (cursor
// print mode and `agy -p` emit nothing), so they keep the spinner fallback:
// braille animating in the OSC title (noteAgentTitle) or terminal body
// (noteAgentSpinnerByte) means running (see agentSpinner), and a settle timer
// (WAITING_SETTLE_MS) bridges spinner-frame gaps before flipping to
// waitingForInput and notifying.
//
// A hook-covered agent flips onto the hook-driven path only once its FIRST
// hook event arrives — never on presence alone. Injection is best-effort (the
// PATH shim loses to rc-file PATH prepends, aliases, and absolute-path
// launches), so an agent that never speaks hooks must degrade to the spinner
// fallback instead of sitting on waitingForInput through every turn. Once an
// event has arrived the events are authoritative for that process: spinner
// inputs are ignored from then on (a stray braille glyph in `cat`ed output
// cannot flip state), until the process exits and the latch resets.
//
// Presence (noteAgentPresence, fed 1 Hz from main's process-tree scan) stays
// authoritative for EXISTENCE on both paths: hooks can't report a crash or
// exit (codex never fires SessionEnd), so notRunning/finished always come
// from the scan.
// =============================================================================

import { useStatusStore, workspaceIdForTerminal } from '../../stores/statusStore'
import { sendOsNotification } from '../notifications/osNotificationSend'
import { resolveAgentState, WAITING_SETTLE_MS, BODY_SPINNER_TIMEOUT_MS } from './agentScreenDetectorLogic'
import { AGENTS, type AgentId } from '../../../shared/agents'
import type { AgentHookEvent } from '../../../shared/agentHooks'
import type { AgentState } from '../../../shared/types'

/** Agents whose running/idle state comes from hook events once any arrive.
 *  cursor/agy are deliberately absent — they stay on the spinner fallback
 *  permanently (see header). */
const HOOK_STATUS_AGENTS: ReadonlySet<AgentId> = new Set<AgentId>([
  'claude-code',
  'codex',
  'pi',
  'opencode',
])

/** statusStore carries the agent's DISPLAY name (from the process scan);
 *  routing needs the id. AGENTS is the single source for both, so the lookup
 *  is a bijection. */
const AGENT_ID_BY_DISPLAY_NAME: ReadonlyMap<string, AgentId> = new Map(
  AGENTS.map((a) => [a.displayName, a.id]),
)

// The Tracker holds ONLY hook/spinner/timer/FSM-edge state. The agent name and
// presence are owned by statusStore (the single home); the tracker reads them
// from there at commit time rather than caching a second copy that two writers
// could clobber on the same 1 Hz tick. `present/wasPresent/state` remain here
// because they are load-bearing FSM edge-detection memory (e.g. resolveAgentState
// and the running->waiting settle gate).
interface Tracker {
  present: boolean
  wasPresent: boolean
  /** True once this terminal's agent has actually spoken hooks: spinner
   *  inputs are ignored and hookTurnActive drives running/idle. Latched by
   *  the FIRST hook event only — never by presence, because injection is
   *  best-effort (PATH shims lose to rc-file prepends/aliases) and a
   *  hook-covered agent whose injection was bypassed must keep the spinner
   *  fallback. Reset when the process exits (the next launch re-proves
   *  itself) or when the scan finds a fallback agent in the terminal. */
  hookDriven: boolean
  /** turn-start seen more recently than turn-end/session-end. */
  hookTurnActive: boolean
  /** The in-flight turn is parked on a permission prompt (permission-wait seen
   *  more recently than turn-resume/turn-start/turn-end). Splits "turn active"
   *  from "turn active but blocked" so the 1 Hz presence tick keeps showing
   *  waitingForInput while blocked instead of flipping back to running. */
  hookPermissionWait: boolean
  titleSpinner: boolean
  bodySpinner: boolean
  state: AgentState
  /** Pending running→waitingForInput settle (fallback path only), or null. */
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
      hookDriven: false,
      hookTurnActive: false,
      hookPermissionWait: false,
      titleSpinner: false,
      bodySpinner: false,
      state: 'notRunning',
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

/** Flip a tracker onto the hook-driven path: spinner state (and its timers)
 *  is dead weight from here on, so drop it rather than leaving a stale flag
 *  that a later recompute could misread. */
function markHookDriven(t: Tracker): void {
  if (t.hookDriven) return
  t.hookDriven = true
  t.titleSpinner = false
  t.bodySpinner = false
  clearTimers(t)
}

function workspaceFor(terminalId: string): string | undefined {
  return workspaceIdForTerminal(terminalId)
}

/** The AgentId currently detected in a terminal, derived from the display name
 *  the process scan wrote to statusStore (set before noteAgentPresence runs on
 *  the same telemetry tick). */
function agentIdForTerminal(terminalId: string): AgentId | null {
  const workspaceId = workspaceFor(terminalId)
  if (!workspaceId) return null
  const name = useStatusStore.getState().workspaces[workspaceId]?.terminals[terminalId]?.agentName
  return (name && AGENT_ID_BY_DISPLAY_NAME.get(name)) || null
}

/** Apply a resolved state to the store + mirror it to other windows. `notify`
 *  fires the OS notification; the settle timer (fallback path), hook turn-end,
 *  and permission-wait pass true. `permissionBody` switches the text to the
 *  "needs permission" variant carrying what the agent is blocked on. The agent
 *  name is read from statusStore (its single home) at commit time — the
 *  tracker doesn't cache a parallel copy. Notification is transition-gated:
 *  commit no-ops when the state didn't change, so a repeated permission-wait
 *  without an intervening resume cannot re-notify. */
function commit(terminalId: string, state: AgentState, notify: boolean, permissionBody?: string): void {
  const t = trackers.get(terminalId)
  if (!t || t.state === state) return
  const workspaceId = workspaceFor(terminalId)
  if (!workspaceId) return

  t.state = state
  const status = useStatusStore.getState()
  const agentName = status.workspaces[workspaceId]?.terminals[terminalId]?.agentName ?? null
  status.setAgentState(workspaceId, terminalId, state, agentName)
  window.electronAPI?.shellReportAgentScreenState?.(terminalId, state)

  if (notify && state === 'waitingForInput') {
    const displayName = agentName ?? 'Agent'
    sendOsNotification({
      title: permissionBody ? `${displayName} needs permission` : `${displayName} needs input`,
      body: permissionBody ?? `${displayName} is waiting for your response.`,
      action: { type: 'focusTerminal', workspaceId, terminalId },
    })
  }
}

/** Short human line for the permission notification: WHAT the agent wants,
 *  from the per-CLI raw payload (pinned live in agentHookContracts.itest.ts). */
function permissionBodyFor(event: AgentHookEvent): string {
  const raw = event.raw
  let detail: unknown
  switch (event.agentId) {
    case 'claude-code':
      detail = raw.message // "Claude needs your permission"
      break
    case 'codex':
      detail = (raw.tool_input as { command?: unknown } | undefined)?.command ?? raw.tool_name
      break
    case 'opencode':
      detail = (raw.metadata as { command?: unknown } | undefined)?.command
      break
  }
  const text = typeof detail === 'string' && detail.trim() ? detail.trim() : 'Waiting for your approval.'
  return text.length > 120 ? `${text.slice(0, 119)}…` : text
}

/** `notifyOnIdle` is set only by hook turn-end and permission-wait: the event
 *  is authoritative, so a resulting flip to waitingForInput notifies
 *  immediately (commit no-ops when the state didn't actually change, so only
 *  the running→waiting edge fires). `permissionBody` rides along for the
 *  permission variant. The fallback path ignores both — its settle timer owns
 *  notification. */
function recompute(terminalId: string, notifyOnIdle = false, permissionBody?: string): void {
  const t = trackers.get(terminalId)
  if (!t || !started) return

  const raw = resolveAgentState({
    present: t.present,
    wasPresent: t.wasPresent,
    active: t.hookDriven ? t.hookTurnActive && !t.hookPermissionWait : t.titleSpinner || t.bodySpinner,
  })

  if (t.hookDriven) {
    commit(terminalId, raw, notifyOnIdle, permissionBody)
    return
  }

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

/** A normalized agent-hook event arrived for a terminal this window owns.
 *  Only hook-covered agents route here — cursor/agy do fire hook events in
 *  interactive mode, but their state is owned by the spinner fallback (one
 *  driver per agent, no mixed signals). */
export function noteAgentHookEvent(event: AgentHookEvent): void {
  if (!HOOK_STATUS_AGENTS.has(event.agentId)) return
  const t = trackerFor(event.terminalId)
  markHookDriven(t)
  switch (event.kind) {
    case 'turn-start':
      t.hookTurnActive = true
      t.hookPermissionWait = false
      recompute(event.terminalId)
      break
    case 'turn-resume':
      // The blocked tool call resolved (or an ordinary tool call completed) —
      // the turn is in flight again. Idempotent and silent.
      t.hookTurnActive = true
      t.hookPermissionWait = false
      recompute(event.terminalId)
      break
    case 'turn-end':
      // Also lands after a DENIED permission: state is already waiting then,
      // so commit's transition gate swallows the would-be second notification.
      t.hookTurnActive = false
      t.hookPermissionWait = false
      recompute(event.terminalId, true)
      break
    case 'session-end':
      // Like turn-end for state (the process may keep running after /clear),
      // but silent — only a genuine turn end notifies.
      t.hookTurnActive = false
      t.hookPermissionWait = false
      recompute(event.terminalId)
      break
    case 'session-start':
      // A fresh session starts idle; no turn is in flight yet.
      t.hookTurnActive = false
      t.hookPermissionWait = false
      recompute(event.terminalId)
      break
    case 'permission-wait':
      // Mid-turn block on the user's approval: show waiting NOW and say what
      // is blocked. If the event races ahead of the first presence tick the
      // notification is skipped with the state change (same pre-presence
      // semantics as every other hook event); the model needs seconds to
      // reach a tool call, so in practice presence always lands first.
      t.hookPermissionWait = true
      recompute(event.terminalId, true, permissionBodyFor(event))
      break
  }
}

/** Title changed for a terminal — `running` is the spinner classification.
 *  Fallback (cursor/agy) input only; hook-covered agents ignore it. */
export function noteAgentTitle(terminalId: string, running: boolean): void {
  const t = trackerFor(terminalId)
  if (t.hookDriven) return
  t.titleSpinner = running
  recompute(terminalId)
}

/** A braille spinner frame was seen in the terminal body. Marks a fallback
 *  agent running until the frames stop; hook-covered agents ignore it. */
export function noteAgentSpinnerByte(terminalId: string): void {
  const t = trackerFor(terminalId)
  if (t.hookDriven) return
  t.bodySpinner = true
  if (t.bodyTimer) clearTimeout(t.bodyTimer)
  t.bodyTimer = setTimeout(() => {
    t.bodyTimer = null
    t.bodySpinner = false
    recompute(terminalId)
  }, BODY_SPINNER_TIMEOUT_MS)
  recompute(terminalId)
}

/** Main's process scan reported whether the agent CLI is present. The agent
 *  name is written to statusStore by the caller (useProcessMonitor) BEFORE
 *  this runs, so the hook/fallback routing derived from it here is current.
 *  Presence never latches hookDriven — only a real hook event proves the
 *  injection worked (see the Tracker.hookDriven doc). */
export function noteAgentPresence(terminalId: string, present: boolean): void {
  const t = trackerFor(terminalId)
  t.wasPresent = t.present
  t.present = present
  if (present) {
    const agentId = agentIdForTerminal(terminalId)
    if (agentId && t.hookDriven && !HOOK_STATUS_AGENTS.has(agentId)) {
      // A fallback agent (cursor/agy) took over a terminal that previously ran
      // a hook-covered one — hand state back to the spinner path.
      t.hookDriven = false
      t.hookTurnActive = false
      t.hookPermissionWait = false
    }
  } else {
    // The process is gone; any in-flight turn died with it. Clearing also
    // drops the hookDriven latch: the NEXT launch may be injection-bypassed
    // (alias/absolute path), so it must re-prove hooks before spinners are
    // ignored again.
    t.hookDriven = false
    t.hookTurnActive = false
    t.hookPermissionWait = false
  }
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
  const workspaceId = workspaceIdForTerminal(terminalId)
  if (!workspaceId) return
  const agentName = status.workspaces[workspaceId]?.terminals[terminalId]?.agentName ?? null
  status.setAgentState(workspaceId, terminalId, state, agentName)
}
