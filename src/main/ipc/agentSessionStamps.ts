// =============================================================================
// Agent-session stamping — decides WHEN a terminal's agent session becomes the
// persisted resume stamp ({agentId, sessionId, cwd} on the terminal's
// PanelState, saved into .cate/session.json and typed back as a resume command
// on restore). Emits SHELL_AGENT_SESSION_UPDATE, so the renderer/persistence/
// restore chain is unchanged from the old probe-based producer.
//
// Identity comes from HOOK EVENTS ONLY (this module's ingest): the agent CLIs
// push their own session identity through the unified hook stream
// (agentHooks.ts / agentHookEvents.ts) the moment it changes — fresh by
// construction. There is deliberately NO store-scanning fallback: an agent
// whose hooks never speak (launched before injection, codex trust not yet
// granted) simply has no resume stamp — a guessed stamp risks resuming the
// WRONG session, which is worse than a plain-shell restore. The 1 Hz scan
// (shell.ts) stays the authority on "agent gone": it reports the liveness of
// the pid the agent's own hook posts registered (agentPresence.ts), and its
// falling edge clears the stamp, so the next run re-proves itself via fresh
// events.
//
// Resumability gating: a stamp is only worth persisting if resuming it works.
// claude's SessionStart fires at TUI launch BEFORE any transcript exists, and
// resuming a transcript-less id FAILS (pinned live by
// agentHookContracts.itest.ts) — so claude is only stamped from its first
// turn event. See RESUMABLE_FROM_SESSION_START below.
// =============================================================================

import { SHELL_AGENT_SESSION_UPDATE } from '../../shared/ipc-channels'
import type { AgentHookEvent } from '../../shared/agentHooks'
import type { AgentId } from '../../shared/agents'
import type { Runtime } from '../runtime/types'
import type { TerminalAgentSession } from '../../shared/types'
import { getTerminalOwner } from './terminal'
import { sendToWindow } from '../windowRegistry'

/**
 * Whether this agent's session is already resumable when its session-start
 * event arrives. Every CLI persists its session lazily, but only claude both
 * announces a session BEFORE anything is persisted (SessionStart at TUI
 * launch, and again on /clear rotation) and FAILS to resume that empty id —
 * so claude waits for the first turn event (turn-start = prompt submitted;
 * turn-end / permission-wait equally prove a submitted prompt). Everyone
 * else's first sessionId-bearing event is already tied to a persisted store:
 * codex's TUI pushes nothing until the first submit (exec pushes at start,
 * with the rollout as transcript), pi/opencode create-or-resume by exact id.
 * Contracts pinned live in agentHookContracts.itest.ts.
 */
const RESUMABLE_FROM_SESSION_START: Record<AgentId, boolean> = {
  'claude-code': false,
  codex: true,
  // A never-used sessionStart id is resumable (--resume even ADOPTS unknown
  // ids as a fresh chat rather than failing) — pinned live.
  cursor: true,
  // grok's TUI defers SessionStart to the first prompt submit, so a session is
  // already open and on disk when the id arrives — a session killed mid-turn,
  // before its Stop, still resumes (pinned live).
  grok: true,
  pi: true,
  opencode: true,
}

interface StampState {
  /** Dedup key of the last SHELL_AGENT_SESSION_UPDATE sent, so an unchanged
   *  stamp doesn't re-emit (and re-touch renderer panel state). */
  key?: string | null
  /** Monotonic ingest counter — an async cwd lookup captures it and drops its
   *  result if a newer event (or a clear) landed while it was in flight. */
  seq: number
}

const states = new Map<string, StampState>()

function stateFor(terminalId: string): StampState {
  let st = states.get(terminalId)
  if (!st) {
    st = { seq: 0 }
    states.set(terminalId, st)
  }
  return st
}

/** Send a stamp (or a clear) to the terminal's owner window, deduped. */
function emit(terminalId: string, session: TerminalAgentSession | null): void {
  const ownerWindowId = getTerminalOwner(terminalId)
  if (ownerWindowId == null) return
  const st = stateFor(terminalId)
  const key = session ? `${session.agentId}\0${session.sessionId}\0${session.cwd}` : null
  if (st.key === key) return
  st.key = key
  sendToWindow(ownerWindowId, SHELL_AGENT_SESSION_UPDATE, terminalId, session)
}

/**
 * Ingest one normalized hook event and update the terminal's resume stamp:
 * session-end clears it (a /clear rotation's follow-up session-start carries
 * the new id and re-stamps under the same gating — a claude session that was
 * /clear'd but never prompted again stays CLEARED, not stale); any other
 * sessionId-bearing event stamps, except a session-start for an agent whose
 * sessions aren't resumable yet at that point (claude).
 *
 * cwd: the event's own cwd when the payload carries one (claude/codex/pi/
 * opencode); when an event doesn't, the terminal's current cwd is fetched
 * from its runtime. Restore only types `<cli> <resume-args>` into the
 * respawned shell (worktree respawn drops the stamp wholesale rather than
 * comparing cwds), so the stamp's cwd is informational.
 */
export function ingestAgentSessionStamp(runtime: Runtime, event: AgentHookEvent): void {
  const { terminalId } = event
  const st = stateFor(terminalId)
  st.seq++
  if (event.kind === 'session-end') {
    emit(terminalId, null)
    return
  }
  if (event.sessionId == null) return
  if (event.kind === 'session-start' && !RESUMABLE_FROM_SESSION_START[event.agentId]) return
  const { agentId, sessionId } = event
  if (event.cwd) {
    emit(terminalId, { agentId, sessionId, cwd: event.cwd })
    return
  }
  const seq = st.seq
  void runtime.process
    .getCwd(terminalId)
    .then((cwd) => {
      if (states.get(terminalId)?.seq !== seq) return // superseded while in flight
      emit(terminalId, { agentId, sessionId, cwd: cwd ?? '' })
    })
    .catch(() => { /* runtime gone — no stamp beats a cwd-less guess */ })
}

/** Falling edge: the agent exited while the terminal lives on — nothing to
 *  resume. Clears the stamp; the next agent run re-stamps via fresh events. */
export function clearAgentSessionStamp(terminalId: string): void {
  const st = stateFor(terminalId)
  st.seq++
  emit(terminalId, null)
}

/** The terminal itself is gone — drop its stamp state. */
export function dropAgentSessionStampState(terminalId: string): void {
  states.delete(terminalId)
}
