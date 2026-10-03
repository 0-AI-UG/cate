// Resume stamps: decides when a terminal's agent session becomes the stamp
// the terminal panel persists and types back as a resume command on restore.
//
// Identity comes from hook events only. There is deliberately no store
// scanning fallback: an agent whose hooks never speak has no stamp, because a
// guessed stamp risks resuming the wrong session, which is worse than a
// plain-shell restore. Presence is the authority on "agent gone": its falling
// edge clears the stamp, and the next run proves itself through fresh events.
//
// A stamp is only worth persisting if resuming it works. Claude announces an
// id before its transcript exists and Kiro before its first turn is saved;
// both are stamped from their first turn event (resume.fromSessionStart).

import { AGENT_DEFS, normalizeAgentSourceStartedAt, type AgentHookEvent, type AgentId, type TerminalResumeStamp } from '../contract'

interface StampState {
  /** Dedup key of the last emitted stamp. */
  key?: string | null
  latest?: {
    agentId: AgentId
    sessionId: string
    profile?: string
    cwd?: string
    sourcePid?: number
    sourceStartedAt?: string
  }
  /** Newest process start clock seen from an in-process (`hookProcess: 'self'`) agent. */
  sourceStartedHighWater?: bigint
  /** Ingest counter: an async cwd lookup drops its result when a newer event
   *  (or a clear) landed while it was in flight. */
  seq: number
}

export interface ResumeStampsDeps {
  /** The terminal's current cwd, for events that carry none. */
  getCwd(terminalId: string): Promise<string | null>
  /** A stamp changed (null clears it). Deduplicated. */
  emit(terminalId: string, stamp: TerminalResumeStamp | null): void
}

export interface ResumeStamps {
  ingest(event: AgentHookEvent): void
  /** Presence falling edge: the agent exited while the terminal lives on. */
  clear(terminalId: string, endedAgentPid?: number, endedAgentStartedAt?: string): void
  /** The session the terminal's hooks last named, stamped or not. */
  latest(terminalId: string): { agentId: AgentId; sessionId: string; profile?: string; cwd?: string } | undefined
  drop(terminalId: string): void
}

export function createResumeStamps(deps: ResumeStampsDeps): ResumeStamps {
  const states = new Map<string, StampState>()

  const stateFor = (terminalId: string): StampState => {
    let st = states.get(terminalId)
    if (!st) {
      st = { seq: 0 }
      states.set(terminalId, st)
    }
    return st
  }

  const emit = (terminalId: string, stamp: TerminalResumeStamp | null): void => {
    const st = stateFor(terminalId)
    const key = stamp ? `${stamp.agentId}\0${stamp.sessionId}\0${stamp.cwd}\0${stamp.profile ?? ''}` : null
    if (st.key === key) return
    st.key = key
    deps.emit(terminalId, stamp)
  }

  return {
    /**
     * session-end clears the stamp (a /clear rotation's follow-up
     * session-start carries the new id and re-stamps under the same gating);
     * any other event with a session id stamps, except a session-start of an
     * agent whose sessions are not resumable yet at that point. The cwd is
     * the event's own, else the terminal's current one.
     */
    ingest(event) {
      const { terminalId } = event
      if (event.kind === 'session-title' || event.kind === 'input-submit') return
      const st = stateFor(terminalId)
      const agent = AGENT_DEFS[event.agentId]
      // An in-process hook stamps each event with its process start clock;
      // drop events from an older process of the agent in this terminal.
      if (agent?.hookProcess === 'self') {
        const startedAt = normalizeAgentSourceStartedAt(event.sourceStartedAt)
        if (!startedAt && st.sourceStartedHighWater !== undefined) return
        if (startedAt) {
          const incoming = BigInt(startedAt)
          if (st.sourceStartedHighWater !== undefined && incoming < st.sourceStartedHighWater) return
          st.sourceStartedHighWater = incoming
        }
      }
      if (event.kind === 'session-end') {
        if (!event.sessionId) return
        if (st.latest && (
          st.latest.agentId !== event.agentId ||
          st.latest.sessionId !== event.sessionId ||
          (event.profile !== undefined && st.latest.profile !== event.profile) ||
          (event.sourcePid !== undefined && st.latest.sourcePid !== undefined && st.latest.sourcePid !== event.sourcePid) ||
          (event.sourceStartedAt !== undefined && st.latest.sourceStartedAt !== undefined && st.latest.sourceStartedAt !== event.sourceStartedAt)
        )) return
        st.seq++
        st.latest = undefined
        emit(terminalId, null)
        return
      }
      if (event.sessionId == null) return
      st.seq++
      const { agentId, sessionId } = event
      const profile = event.profile ? { profile: event.profile } : {}
      const identity = {
        agentId,
        sessionId,
        ...profile,
        ...(event.cwd ? { cwd: event.cwd } : {}),
        ...(event.sourcePid ? { sourcePid: event.sourcePid } : {}),
        ...(event.sourceStartedAt ? { sourceStartedAt: event.sourceStartedAt } : {}),
      }
      if (event.kind === 'session-start' && !agent?.runners.terminal.resume.fromSessionStart) {
        const previous = st.latest
        st.latest = identity
        // A new session replaced the stamped one without ending it first
        // (Hermes's session reset): the old stamp no longer runs here.
        if (previous?.agentId === agentId && (
          previous.sessionId !== sessionId || previous.profile !== event.profile
        )) emit(terminalId, null)
        return
      }
      st.latest = identity
      if (event.cwd) {
        emit(terminalId, { agentId, sessionId, cwd: event.cwd, ...profile })
        return
      }
      const seq = st.seq
      void deps.getCwd(terminalId)
        .then((cwd) => {
          if (states.get(terminalId)?.seq !== seq) return // superseded while in flight
          emit(terminalId, { agentId, sessionId, cwd: cwd ?? '', ...profile })
        })
        .catch(() => { /* terminal gone: no stamp beats a cwd-less guess */ })
    },

    clear(terminalId, endedAgentPid, endedAgentStartedAt) {
      const st = stateFor(terminalId)
      if (endedAgentPid !== undefined && st.latest?.sourcePid !== undefined && st.latest.sourcePid !== endedAgentPid) return
      if (
        endedAgentStartedAt !== undefined &&
        st.latest?.sourceStartedAt !== undefined &&
        st.latest.sourceStartedAt !== endedAgentStartedAt
      ) return
      st.seq++
      st.latest = undefined
      emit(terminalId, null)
    },

    latest(terminalId) {
      const latest = states.get(terminalId)?.latest
      if (!latest) return undefined
      return {
        agentId: latest.agentId,
        sessionId: latest.sessionId,
        ...(latest.profile ? { profile: latest.profile } : {}),
        ...(latest.cwd ? { cwd: latest.cwd } : {}),
      }
    },

    drop(terminalId) {
      states.delete(terminalId)
    },
  }
}
