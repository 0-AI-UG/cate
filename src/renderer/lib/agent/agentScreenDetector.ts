// =============================================================================
// Agent activity coordinator: a hook-event FSM plus presence edges.
//
// Running/idle for all agents is driven by the
// normalized agent-hook event stream (SHELL_AGENT_HOOK_EVENT →
// noteAgentHookEvent): turn-start flips to 'running' immediately, turn-end
// flips back to 'waitingForInput' and fires the "needs input" notification,
// and session-end is treated like turn-end for state (the process may keep
// running after /clear). Codex permission-check is interpreted using config: hooks can
// run before an automatic reviewer or another hook resolves the request. Manual
// config and confirmed permission-wait send a permission notification.
// turn-resume (a permission reply or tool activity) flips back to 'running'
// silently. For CLIs with no approval-reply hook, runtime PTY input supplies the
// earlier resume edge on the same ordered stream as the hooks. The signals
// are authoritative, so no settle timer is involved.
//
// Presence (noteAgentPresence, fed 1 Hz from main's activity scan) stays
// authoritative for EXISTENCE — but it is itself hook-anchored now: the
// daemon registers the agent's pid from its first hook post's lineage
// (runtime/capabilities/agentPresence.ts) and the scan reports that pid's
// liveness. Hooks can't report a crash or exit (codex never fires
// SessionEnd), so notRunning/finished still come from the scan's falling
// edge.
//
// Hook injection is best-effort, and hooks are the ONLY detection channel:
// an agent that never speaks them (codex before its native trust prompt is
// answered, a CLI launched before Cate injected the files, an unparseable
// settings file) is simply not detected — no indicator, no notifications,
// like any other process in the terminal.
// =============================================================================

import { useStatusStore, workspaceIdForTerminal } from '../../stores/statusStore'
import { notifyAgentNeedsAttention } from './agentNotifications'
import type { AgentHookEvent } from '../../../shared/agentHooks'
import { AGENTS } from '../../../shared/agents'
import type { AgentState } from '../../../shared/types'
import type { AgentApprovalMode } from '../../../shared/agentApprovalModes'

export interface DetectorSignals {
  /** Main's process-tree scan found the agent CLI for this terminal. */
  present: boolean
  /** The agent was present on the previous observation (for finished edge). */
  wasPresent: boolean
  /** A turn is in flight (hook turn-start seen more recently than a turn-end). */
  active: boolean
  permission?: 'checking' | 'waiting' | null
  /** Present only by foreground process name; no hook has spoken for this
   *  launch, so idle vs busy is unknown. */
  processOnly?: boolean
}

export function resolveAgentState(s: DetectorSignals): AgentState {
  if (!s.present && s.wasPresent) return 'finished'
  if (!s.present) return 'notRunning'
  if (s.processOnly) return 'notRunning'
  if (s.permission === 'waiting') return 'waitingForInput'
  if (s.active) return 'running'
  return 'waitingForInput'
}

// The Tracker holds ONLY hook/FSM-edge state. The agent name and presence are
// owned by statusStore (the single home); the tracker reads them from there at
// commit time rather than caching a second copy that two writers could clobber
// on the same 1 Hz tick. `present/wasPresent/state` remain here because they
// are load-bearing FSM edge-detection memory (resolveAgentState's finished
// edge and commit's transition gate).
interface Tracker {
  present: boolean
  wasPresent: boolean
  /** A hook (event or the scan's hook-registered pid) proved this launch.
   *  Without it presence is process-name only: state unknown, never idle. */
  hookProven: boolean
  /** Current CLI session identity. Used to make a deferred/replayed
   *  session-start idempotent instead of letting it overwrite a turn event
   *  from the same session that already arrived. */
  sessionId: string | null
  /** Agent that produced the latest hook for this terminal. */
  agentId: AgentHookEvent['agentId'] | null
  /** Active CLI turn identity, when the hook payload provides one. */
  activeTurnId: string | null
  /** turn-start seen more recently than turn-end/session-end. */
  hookTurnActive: boolean
  /** Only 'waiting' proves that a human response is needed. */
  permission: 'checking' | 'waiting' | null
  approvalMode?: AgentApprovalMode
  /** Reject late lifecycle events from the last completed turn. */
  endedTurnId: string | null
  state: AgentState
}

const trackers = new Map<string, Tracker>()
let started = false

function trackerFor(terminalId: string): Tracker {
  let t = trackers.get(terminalId)
  if (!t) {
    t = {
      present: false,
      wasPresent: false,
      hookProven: false,
      sessionId: null,
      agentId: null,
      activeTurnId: null,
      hookTurnActive: false,
      permission: null,
      endedTurnId: null,
      state: 'notRunning',
    }
    trackers.set(terminalId, t)
  }
  return t
}

function workspaceFor(terminalId: string): string | undefined {
  return workspaceIdForTerminal(terminalId)
}

/** Apply a resolved state to the store + mirror it to other windows. `notify`
 *  fires the OS notification for completion or a manual permission request.
 *  `permissionBody` switches the text to the "needs permission" variant
 *  carrying what the agent is blocked on. The agent name is read from
 *  statusStore (its single home) at commit time — the tracker doesn't cache a
 *  parallel copy. Notification is transition-gated: commit no-ops when the
 *  state didn't change, so a repeated permission-wait without an intervening
 *  resume cannot re-notify. */
function commit(terminalId: string, state: AgentState, notify: boolean, permissionBody?: string): void {
  const t = trackers.get(terminalId)
  if (!t || t.state === state) return
  const workspaceId = workspaceFor(terminalId)
  if (!workspaceId) return

  t.state = state
  const status = useStatusStore.getState()
  const agentId = status.workspaces[workspaceId]?.terminals[terminalId]?.agentId ?? null
  status.setAgentState(workspaceId, terminalId, state)
  window.electronAPI?.shellReportAgentScreenState?.(terminalId, state)

  if (notify && state === 'waitingForInput') {
    notifyAgentNeedsAttention({
      agentName: AGENTS.find((agent) => agent.id === agentId)?.displayName ?? null,
      action: { type: 'focusTerminal', workspaceId, terminalId },
      permission: permissionBody,
    })
  }
}

/** Short human line for the permission notification: WHAT the agent wants,
 *  as its hook spec extracted it (pinned live in agentHookContracts.itest.ts). */
function permissionBodyFor(event: AgentHookEvent): string {
  const text = event.permission ?? 'Waiting for your approval.'
  return text.length > 120 ? `${text.slice(0, 119)}…` : text
}

/** Completion and permission events set `notifyOnIdle`: a resulting flip to
 *  waitingForInput notifies immediately (commit no-ops when the state didn't actually change, so only
 *  the running→waiting edge fires). `permissionBody` rides along for the
 *  permission variant. */
function recompute(terminalId: string, notifyOnIdle = false, permissionBody?: string): void {
  const t = trackers.get(terminalId)
  if (!t || !started) return

  const raw = resolveAgentState({
    present: t.present,
    wasPresent: t.wasPresent,
    active: t.hookTurnActive,
    permission: t.permission === 'checking' && t.agentId === 'codex' && t.approvalMode === 'manual'
      ? 'waiting' : t.permission,
    processOnly: !t.hookProven,
  })
  commit(terminalId, raw, notifyOnIdle, permissionBody)
}

/** A normalized agent-hook event arrived for a terminal this window owns. */
export function noteAgentHookEvent(event: AgentHookEvent): void {
  const t = trackerFor(event.terminalId)
  // Metadata and delayed child/previous-session hooks cannot end or block the
  // current turn. Session/turn starts are the explicit identity boundaries.
  if (!['session-start', 'turn-start', 'session-title'].includes(event.kind)) {
    if (t.agentId && t.agentId !== event.agentId) return
    if (t.sessionId && event.sessionId && t.sessionId !== event.sessionId) return
    if (t.activeTurnId && event.turnId && t.activeTurnId !== event.turnId) return
    if (event.turnId && event.turnId === t.endedTurnId) return
  }
  if (event.kind === 'session-title') return
  t.agentId = event.agentId
  t.sessionId ??= event.sessionId
  t.hookProven = true
  switch (event.kind) {
    case 'input-submit':
      noteAgentInputSubmitted(event.terminalId)
      break
    case 'turn-start':
      t.sessionId = event.sessionId
      t.activeTurnId = event.turnId ?? null
      t.endedTurnId = null
      t.hookTurnActive = true
      t.permission = null
      recompute(event.terminalId)
      break
    case 'turn-resume':
      // A permission reply arrived or a tool completed — either way the turn
      // is in flight. Idempotent and silent.
      t.hookTurnActive = true
      t.activeTurnId ??= event.turnId ?? null
      t.permission = null
      recompute(event.terminalId)
      break
    case 'turn-end':
      // Also lands after a DENIED permission: state is already waiting then,
      // so commit's transition gate swallows the would-be second notification.
      t.endedTurnId = event.turnId ?? t.activeTurnId
      t.activeTurnId = null
      t.hookTurnActive = false
      t.permission = null
      // A turn-end the runtime recovered from a user interrupt is silent: the
      // user is already at the terminal.
      recompute(event.terminalId, !event.interrupted)
      break
    case 'session-end':
      // Like turn-end for state (the process may keep running after /clear),
      // but silent — only a genuine turn end notifies.
      t.activeTurnId = null
      t.hookTurnActive = false
      t.permission = null
      recompute(event.terminalId)
      break
    case 'session-start':
      // Codex defers SessionStart until the first prompt and delivers it on a
      // separate hook post from UserPromptSubmit. If the prompt event won that
      // race, a SessionStart for the SAME session is only identity
      // confirmation; resetting it would flicker a running turn back to
      // waitingForInput. A genuinely new session (e.g. /clear) still starts
      // idle.
      if (t.sessionId === event.sessionId && t.hookTurnActive) break
      if (t.sessionId !== event.sessionId) t.endedTurnId = null
      t.sessionId = event.sessionId
      t.activeTurnId = null
      t.hookTurnActive = false
      t.permission = null
      recompute(event.terminalId)
      break
    case 'permission-check':
      // Keep this turn busy, including when the first event we saw was the
      // approval hook. Never downgrade a confirmed human wait to an ambiguous
      // check (parallel tool calls can emit both).
      t.hookTurnActive = true
      t.activeTurnId ??= event.turnId ?? null
      if (t.permission !== 'waiting') t.permission = 'checking'
      t.approvalMode = event.approvalMode
      recompute(event.terminalId, true, permissionBodyFor(event))
      break
    case 'permission-wait':
      // Mid-turn block on the user's approval: show waiting NOW and say what
      // is blocked. If the event races ahead of the first presence tick the
      // notification is skipped with the state change (same pre-presence
      // semantics as every other hook event); the model needs seconds to
      // reach a tool call, so in practice presence always lands first.
      t.hookTurnActive = true
      t.activeTurnId ??= event.turnId ?? null
      t.permission = 'waiting'
      recompute(event.terminalId, true, permissionBodyFor(event))
      break
  }
}

/** The user submitted a response while the CLI was parked on a permission
 *  prompt. Claude, Codex, and Grok do not expose an "approval answered" hook:
 *  runtime-observed Enter supplies an early resume edge, including a human
 *  response to an ambiguous permission-check. A denial also
 *  resumes the agent while it processes that answer, before its Stop. */
export function noteAgentInputSubmitted(terminalId: string): void {
  const t = trackers.get(terminalId)
  if (!t?.permission) return
  t.hookTurnActive = true
  t.permission = null
  recompute(terminalId)
}

/** Hook-derived readiness for addressed prompts. This deliberately excludes a
 * mid-turn permission prompt even though both states render as "needs input". */
export function canAgentReceivePrompt(terminalId: string): boolean {
  const tracker = trackers.get(terminalId)
  return Boolean(tracker?.present && tracker.hookProven && !tracker.hookTurnActive && !tracker.permission)
}

/** Main's scan reported whether the hook-registered agent pid is alive, or
 *  (`processOnly`) that the agent was seen only as the foreground process. The
 *  agent name is written to statusStore by the caller (useProcessMonitor)
 *  BEFORE this runs, so commit reads a current name. */
export function noteAgentPresence(terminalId: string, present: boolean, processOnly = false): void {
  const t = trackerFor(terminalId)
  t.wasPresent = t.present
  t.present = present
  if (present && !processOnly) t.hookProven = true
  if (!present) {
    t.hookProven = false
    // The process is gone; any in-flight turn died with it. The next launch
    // starts idle and re-proves itself through fresh hook events.
    t.activeTurnId = null
    t.endedTurnId = null
    t.sessionId = null
    t.agentId = null
    t.hookTurnActive = false
    t.permission = null
  }
  recompute(terminalId)
}

/** Drop a terminal's tracker (wire into statusStore.unregisterTerminal). */
export function forgetAgentTracker(terminalId: string): void {
  trackers.delete(terminalId)
}

export function startAgentScreenDetector(): void {
  started = true
}

export function stopAgentScreenDetector(): void {
  started = false
  trackers.clear()
}

export function applyRemoteAgentScreenState(terminalId: string, state: AgentState): void {
  const status = useStatusStore.getState()
  const workspaceId = workspaceIdForTerminal(terminalId)
  if (!workspaceId) return
  status.setAgentState(workspaceId, terminalId, state)
}
