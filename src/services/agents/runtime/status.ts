// The terminal runner's status state machine, driven only by hook events and
// pid presence. There is no screen scraping.
//
// Hook events move a terminal between running and waiting: turn-start runs,
// turn-end waits and asks for attention, session-end waits silently (the
// process may keep running after /clear), permission-wait (a confirmed human
// prompt) waits and asks for permission, turn-resume runs again silently. A
// permission-check is not proof a human must answer (an automatic reviewer or
// another hook may resolve it): the turn keeps running, unless the CLI's
// resolved config says approvals are manual (Codex). For CLIs with no
// approval-reply hook, runtime PTY input (input-submit) supplies the earlier
// resume edge on the same ordered stream. The events are authoritative, so no
// settle timer. See docs/agent-activity.md.
//
// Presence stays authoritative for existence. It is hook-anchored: the pid a
// hook post proved is registered (presence.ts) and its liveness is checked on
// each activity scan. Hooks cannot report a crash or exit (codex never fires
// SessionEnd), so notRunning and finished come from presence's falling edge.
// An agent whose hooks never speak is simply not detected.

import { AGENT_APPROVAL_DETECTION, type AgentApprovalMode, type AgentHookEvent, type AgentId, type AgentStatus } from '../contract'

export interface StatusSignals {
  /** The agent is present in the terminal. */
  present: boolean
  /** It was present on the previous observation (the finished edge). */
  wasPresent: boolean
  /** A turn is in flight (turn-start seen more recently than a turn-end). */
  active: boolean
  /** Only 'waiting' proves that a human response is needed. */
  permission?: 'checking' | 'waiting' | null
  /** Present only by foreground process name: no hook has spoken for this
   *  launch, so idle vs busy is unknown. */
  processOnly?: boolean
}

export function resolveAgentStatus(s: StatusSignals): AgentStatus {
  if (!s.present && s.wasPresent) return 'finished'
  if (!s.present) return 'notRunning'
  if (s.processOnly) return 'notRunning'
  if (s.permission === 'waiting') return 'waitingForInput'
  if (s.active) return 'running'
  return 'waitingForInput'
}

export interface AgentStatusChange {
  terminalId: string
  status: AgentStatus
  previous: AgentStatus
  agentId: AgentId | null
  /** Set when the change should reach the user: a turn ended or the agent
   *  blocked on a permission (then `permission` says what it asks). */
  attention?: { permission?: string }
}

interface Tracker {
  present: boolean
  wasPresent: boolean
  /** A hook (an event, or the pid a hook registered) proved this launch.
   *  Without it presence is process-name only: status unknown, never idle. */
  hookProven: boolean
  /** Current CLI session; a replayed session-start of the same session must
   *  not overwrite a turn event that already arrived. */
  sessionId: string | null
  agentId: AgentId | null
  activeTurnId: string | null
  /** turn-start seen more recently than turn-end/session-end. */
  turnActive: boolean
  /** Only 'waiting' proves that a human response is needed. */
  permission: 'checking' | 'waiting' | null
  /** Config fallback for an ambiguous permission-check. */
  approvalMode?: AgentApprovalMode
  /** Rejects late lifecycle events from the last completed turn. */
  endedTurnId: string | null
  status: AgentStatus
}

export interface AgentStatusMachine {
  noteHookEvent(event: AgentHookEvent): void
  /** Presence from an activity scan. `processOnly`: seen only as the
   *  foreground process, no hook-registered pid. */
  notePresence(terminalId: string, present: boolean, processOnly: boolean, agentId: AgentId | null): void
  status(terminalId: string): AgentStatus
  agentId(terminalId: string): AgentId | null
  present(terminalId: string): boolean
  /** At its normal prompt. Excludes a mid-turn permission prompt even though
   *  both show as waiting. */
  canReceivePrompt(terminalId: string): boolean
  forget(terminalId: string): void
}

const PERMISSION_BODY_MAX = 120

/** What the agent asks to do, as its hook spec extracted it. */
function permissionBody(event: AgentHookEvent): string {
  const text = event.permission ?? 'Waiting for your approval.'
  return text.length > PERMISSION_BODY_MAX ? `${text.slice(0, PERMISSION_BODY_MAX - 1)}…` : text
}

export function createAgentStatusMachine(onChange: (change: AgentStatusChange) => void): AgentStatusMachine {
  const trackers = new Map<string, Tracker>()

  const trackerFor = (terminalId: string): Tracker => {
    let t = trackers.get(terminalId)
    if (!t) {
      t = {
        present: false,
        wasPresent: false,
        hookProven: false,
        sessionId: null,
        agentId: null,
        activeTurnId: null,
        turnActive: false,
        permission: null,
        endedTurnId: null,
        status: 'notRunning',
      }
      trackers.set(terminalId, t)
    }
    return t
  }

  /** Transition-gated: nothing happens when the status did not change, so a
   *  repeated permission-wait cannot ask twice. */
  const recompute = (terminalId: string, attention?: AgentStatusChange['attention']): void => {
    const t = trackers.get(terminalId)
    if (!t) return
    const status = resolveAgentStatus({
      present: t.present,
      wasPresent: t.wasPresent,
      active: t.turnActive,
      // A check from a CLI whose config says a human answers is a wait.
      permission: t.permission === 'checking' && t.approvalMode === 'manual'
        && !!t.agentId && AGENT_APPROVAL_DETECTION[t.agentId].source === 'config'
        ? 'waiting' : t.permission,
      processOnly: !t.hookProven,
    })
    if (t.status === status) return
    const previous = t.status
    t.status = status
    onChange({
      terminalId,
      status,
      previous,
      agentId: t.agentId,
      ...(attention && status === 'waitingForInput' ? { attention } : {}),
    })
  }

  const inputSubmitted = (terminalId: string): void => {
    // Claude, Codex and Grok expose no "approval answered" hook: their next
    // hook is PostToolUse, after the approved tool finished. The Enter the
    // runtime observed is the earlier resume edge, including a human response
    // to an ambiguous permission-check; a denial also resumes the agent while
    // it processes the answer.
    const t = trackers.get(terminalId)
    if (!t?.permission) return
    t.turnActive = true
    t.permission = null
    recompute(terminalId)
  }

  return {
    noteHookEvent(event) {
      const t = trackerFor(event.terminalId)
      // Metadata and delayed child or previous-session hooks cannot end or
      // block the current turn. Session and turn starts are the identity
      // boundaries.
      if (event.kind !== 'session-start' && event.kind !== 'turn-start' && event.kind !== 'session-title') {
        if (t.agentId && t.agentId !== event.agentId) return
        if (t.sessionId && event.sessionId && t.sessionId !== event.sessionId) return
        if (t.activeTurnId && event.turnId && t.activeTurnId !== event.turnId) return
        if (event.turnId && event.turnId === t.endedTurnId) return
      }
      t.agentId = event.agentId
      t.hookProven = true
      if (event.kind === 'session-title') return
      t.sessionId ??= event.sessionId
      switch (event.kind) {
        case 'input-submit':
          inputSubmitted(event.terminalId)
          break
        case 'turn-start':
          t.sessionId = event.sessionId
          t.activeTurnId = event.turnId ?? null
          t.endedTurnId = null
          t.turnActive = true
          t.permission = null
          recompute(event.terminalId)
          break
        case 'turn-resume':
          t.turnActive = true
          t.activeTurnId ??= event.turnId ?? null
          t.permission = null
          recompute(event.terminalId)
          break
        case 'turn-end':
          // Also lands after a denied permission: the status already waits
          // then, so the transition gate swallows a second notification.
          t.endedTurnId = event.turnId ?? t.activeTurnId
          t.activeTurnId = null
          t.turnActive = false
          t.permission = null
          // A turn-end recovered from a user interrupt is silent: the user is
          // already at the terminal.
          recompute(event.terminalId, event.interrupted ? undefined : {})
          break
        case 'session-end':
          t.activeTurnId = null
          t.turnActive = false
          t.permission = null
          recompute(event.terminalId)
          break
        case 'session-start':
          // Codex defers SessionStart until the first prompt and posts it
          // separately from UserPromptSubmit. If the prompt won that race, a
          // SessionStart of the same session only confirms identity.
          if (t.sessionId === event.sessionId && t.turnActive) break
          if (t.sessionId !== event.sessionId) t.endedTurnId = null
          t.sessionId = event.sessionId
          t.activeTurnId = null
          t.turnActive = false
          t.permission = null
          recompute(event.terminalId)
          break
        case 'permission-check':
          // Keep the turn busy, also when the approval hook is the first
          // event seen. Never downgrade a confirmed human wait to an ambiguous
          // check (parallel tool calls can emit both).
          t.turnActive = true
          t.activeTurnId ??= event.turnId ?? null
          if (t.permission !== 'waiting') t.permission = 'checking'
          t.approvalMode = event.approvalMode
          recompute(event.terminalId, { permission: permissionBody(event) })
          break
        case 'permission-wait':
          t.turnActive = true
          t.activeTurnId ??= event.turnId ?? null
          t.permission = 'waiting'
          recompute(event.terminalId, { permission: permissionBody(event) })
          break
      }
    },

    notePresence(terminalId, present, processOnly, agentId) {
      const t = trackerFor(terminalId)
      t.wasPresent = t.present
      t.present = present
      if (present && agentId) t.agentId = agentId
      if (present && !processOnly) t.hookProven = true
      if (!present) {
        t.hookProven = false
        // The process is gone and any in-flight turn died with it. The next
        // launch starts idle and proves itself through fresh hook events.
        t.activeTurnId = null
        t.endedTurnId = null
        t.sessionId = null
        t.turnActive = false
        t.permission = null
      }
      recompute(terminalId)
      // Kept through the recompute so the finished edge still names the agent.
      if (!present) t.agentId = null
    },

    status: (terminalId) => trackers.get(terminalId)?.status ?? 'notRunning',
    agentId: (terminalId) => trackers.get(terminalId)?.agentId ?? null,
    present: (terminalId) => trackers.get(terminalId)?.present ?? false,

    canReceivePrompt(terminalId) {
      const t = trackers.get(terminalId)
      return Boolean(t?.present && t.hookProven && !t.turnActive && !t.permission)
    },

    forget(terminalId) {
      trackers.delete(terminalId)
    },
  }
}
