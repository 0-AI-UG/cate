// =============================================================================
// Agent activity coordinator: a hook-event FSM plus presence edges.
//
// Running/idle for all agents (claude/codex/pi/opencode) is driven by the
// normalized agent-hook event stream (SHELL_AGENT_HOOK_EVENT →
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
// Presence (noteAgentPresence, fed 1 Hz from main's process-tree scan) stays
// authoritative for EXISTENCE: hooks can't report a crash or exit (codex never
// fires SessionEnd), so notRunning/finished always come from the scan.
//
// Accepted limitation: hook injection is best-effort. Hook files are
// repo-scoped, so injection no longer depends on how the CLI was launched,
// but an agent can still run without hooks (codex before its native trust
// prompt is answered, a CLI launched before Cate injected the files). An
// agent that never speaks hooks shows 'waitingForInput' for as long as it is
// present — no running shimmer, no notifications — and still resolves to
// finished/notRunning via the process scan.
// =============================================================================

import { useStatusStore, workspaceIdForTerminal } from '../../stores/statusStore'
import { sendOsNotification } from '../notifications/osNotificationSend'
import type { AgentHookEvent } from '../../../shared/agentHooks'
import type { AgentState } from '../../../shared/types'

export interface DetectorSignals {
  /** Main's process-tree scan found the agent CLI for this terminal. */
  present: boolean
  /** The agent was present on the previous observation (for finished edge). */
  wasPresent: boolean
  /** A turn is in flight (hook turn-start seen more recently than a turn-end)
   *  and not parked on a permission prompt. */
  active: boolean
}

export function resolveAgentState(s: DetectorSignals): AgentState {
  if (!s.present && s.wasPresent) return 'finished'
  if (!s.present) return 'notRunning'
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
  /** turn-start seen more recently than turn-end/session-end. */
  hookTurnActive: boolean
  /** The in-flight turn is parked on a permission prompt (permission-wait seen
   *  more recently than turn-resume/turn-start/turn-end). Splits "turn active"
   *  from "turn active but blocked" so the 1 Hz presence tick keeps showing
   *  waitingForInput while blocked instead of flipping back to running. */
  hookPermissionWait: boolean
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
      hookTurnActive: false,
      hookPermissionWait: false,
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
 *  fires the OS notification; hook turn-end and permission-wait pass true.
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
 *  permission variant. */
function recompute(terminalId: string, notifyOnIdle = false, permissionBody?: string): void {
  const t = trackers.get(terminalId)
  if (!t || !started) return

  const raw = resolveAgentState({
    present: t.present,
    wasPresent: t.wasPresent,
    active: t.hookTurnActive && !t.hookPermissionWait,
  })
  commit(terminalId, raw, notifyOnIdle, permissionBody)
}

/** A normalized agent-hook event arrived for a terminal this window owns. */
export function noteAgentHookEvent(event: AgentHookEvent): void {
  const t = trackerFor(event.terminalId)
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

/** Main's process scan reported whether the agent CLI is present. The agent
 *  name is written to statusStore by the caller (useProcessMonitor) BEFORE
 *  this runs, so commit reads a current name. */
export function noteAgentPresence(terminalId: string, present: boolean): void {
  const t = trackerFor(terminalId)
  t.wasPresent = t.present
  t.present = present
  if (!present) {
    // The process is gone; any in-flight turn died with it. The next launch
    // starts idle and re-proves itself through fresh hook events.
    t.hookTurnActive = false
    t.hookPermissionWait = false
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
  const agentName = status.workspaces[workspaceId]?.terminals[terminalId]?.agentName ?? null
  status.setAgentState(workspaceId, terminalId, state, agentName)
}
