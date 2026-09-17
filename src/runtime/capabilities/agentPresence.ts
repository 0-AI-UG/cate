// =============================================================================
// Agent presence — hook-anchored pid registry, the single source of "an agent
// CLI is alive in this terminal".
//
// The old presence leg scanned each pty's DIRECT CHILDREN for an agent-looking
// comm. That tied detection to process-tree topology, which breaks the moment
// anything detaches the agent from the pty's tree (tmux/screen panes hang off
// the multiplexer's server, setsid/nohup daemonize, …). Hooks don't care about
// topology: every hook post is made BY the agent (in-process plugins) or by a
// direct descendant of it (the stdin bridge), so the post itself proves the
// agent exists — and carries a pid that leads to it.
//
// Mechanism:
//   • notePost(terminalId, agentId, pid) — on every authenticated hook post.
//     Walks UP the process-table snapshot from the posted pid (the bridge's
//     parent, or the in-process agent itself) to the nearest ancestor whose
//     comm matches the posting agent's process names, and registers that pid.
//     The walk must run while the post is in flight: the bridge holds the
//     chain alive until it gets its response (agentHooks awaits notePost
//     before responding).
//   • presenceFor(terminalId, tree) — pure lookup against the scan tick's
//     existing snapshot: registered pid still present with the SAME comm
//     (guards pid reuse) → present. Gone → deregister; that falling edge is
//     what resolves 'finished' and clears the resume stamp downstream.
//
// There is deliberately NO other presence source: an agent whose hooks never
// speak (codex before its trust prompt, a CLI launched before injection) is
// simply not present — no indicator, no notifications, same as any untracked
// process. Electron-free; shared by the local and remote daemons.
// =============================================================================

import type { AgentId } from '../../shared/agents'
import { AGENTS } from '../../shared/agents'
import {
  compareAgentProcessGeneration,
  normalizeAgentSourceStartedAt,
  type AgentHookEventKind,
} from '../../shared/agentHooks'
import type { ProcTree } from './procfs'

export interface AgentPresence {
  agentName: string | null
  agentPresent: boolean
  /** Agent pid whose disappearance produced this result. Present only for a
   *  real falling edge, so downstream state can reject an older generation. */
  endedAgentPid?: number
  endedAgentStartedAt?: string
}

export interface AgentPresenceTracker {
  /** Ingest one authenticated hook post's lineage claim. Resolves (and
   *  re-resolves after an agent relaunch) the registered agent pid for the
   *  terminal. Await it before answering the post — the bridge's ancestry
   *  chain is only guaranteed alive while the post is in flight. */
  notePost(
    terminalId: string,
    agentId: AgentId,
    pid: number | undefined,
    kind?: AgentHookEventKind,
    sourceStartedAt?: string,
  ): Promise<void>
  /** Liveness verdict against a process-table snapshot (the scan tick's own).
   *  A registered pid that vanished — or changed comm (pid reuse) — is
   *  deregistered and reads absent: the falling edge. */
  presenceFor(terminalId: string, tree: ProcTree): AgentPresence
  /** The terminal itself is gone — drop its registration. */
  drop(terminalId: string): void
}

export interface AgentPresenceDeps {
  /** Fresh process-table snapshot for notePost's ancestry walk (the scan
   *  tick's snapshot may predate the posting process). */
  snapshot: () => Promise<ProcTree>
  /** Cheap pid-liveness probe for notePost's fast path (tests inject).
   *  Default: signal 0. */
  isAlive?: (pid: number) => boolean
}

interface Registration {
  agentId: AgentId
  pid: number
  /** Pid carried by the hook post. For in-process hooks this is the agent pid;
   *  for bridge-based hooks it distinguishes repeated posts for the fast path. */
  sourcePid: number
  sourceStartedAt?: string
  /** comm at registration time — presenceFor requires it unchanged, so a
   *  recycled pid can't impersonate the agent. */
  comm: string
}

interface TerminalPresenceState {
  /** Highest authenticated Hermes process generation accepted for this
   * terminal. It intentionally outlives the live registration so an older
   * in-flight post cannot reclaim presence after the newer process exits. */
  hermesHighWater?: Pick<Registration, 'sourcePid' | 'sourceStartedAt'>
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = alive but not signalable by us; anything else (ESRCH) = gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Invert childrenByPid into child→parent (ProcTree stores only the downward
 *  edges; the walk here goes up). */
function parentMap(tree: ProcTree): Map<number, number> {
  const parent = new Map<number, number>()
  for (const [ppid, kids] of tree.childrenByPid) {
    for (const kid of kids) parent.set(kid, ppid)
  }
  return parent
}

export function createAgentPresenceTracker(deps: AgentPresenceDeps): AgentPresenceTracker {
  const isAlive = deps.isAlive ?? defaultIsAlive
  const registrations = new Map<string, Registration>()
  const terminalStates = new Map<string, TerminalPresenceState>()

  const stateFor = (terminalId: string): TerminalPresenceState => {
    let state = terminalStates.get(terminalId)
    if (!state) {
      state = {}
      terminalStates.set(terminalId, state)
    }
    return state
  }

  const shouldRetainExisting = (
    existing: Registration,
    agentId: AgentId,
    sourcePid: number,
    kind: AgentHookEventKind | undefined,
    sourceStartedAt: string | undefined,
  ): boolean => {
    if (existing.agentId !== agentId || !isAlive(existing.pid)) return false
    if (agentId !== 'hermes') return true
    const order = compareAgentProcessGeneration(
      { sourcePid, sourceStartedAt },
      existing,
    )
    if (order === -1 || order === 0) return true
    const canReplaceLegacyGeneration = kind === 'session-start' || kind === 'turn-start'
    return order === null && !canReplaceLegacyGeneration
  }

  return {
    async notePost(terminalId, agentId, pid, kind, sourceStartedAt) {
      // Reject anything that isn't a plain positive pid: posts are made by
      // processes inside the terminal, so the value is untrusted input (and
      // pid 0 / negatives address process GROUPS in kill()).
      if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return
      const def = AGENTS.find((a) => a.id === agentId)
      if (!def) return
      const terminalState = stateFor(terminalId)

      // Bridge-based integrations spawn a fresh helper pid for many events, so
      // their live agent registration remains the fast-path authority. Hermes
      // posts in-process: a changed source pid is therefore a new generation
      // even while the previous process is still shutting down.
      const existing = registrations.get(terminalId)
      const canonicalStartedAt = normalizeAgentSourceStartedAt(sourceStartedAt)
      if (
        agentId === 'hermes' &&
        terminalState.hermesHighWater &&
        compareAgentProcessGeneration(
          { sourcePid: pid, sourceStartedAt: canonicalStartedAt },
          terminalState.hermesHighWater,
        ) === -1
      ) return
      if (existing && shouldRetainExisting(existing, agentId, pid, kind, canonicalStartedAt)) return

      const tree = await deps.snapshot()
      const parent = parentMap(tree)
      const visited = new Set<number>()
      // Inclusive walk: an in-process plugin posts the agent's own pid; the
      // bridge posts its parent (possibly with sh/npm layers above it).
      for (let p: number | undefined = pid; p !== undefined && !visited.has(p); p = parent.get(p)) {
        visited.add(p)
        const comm = tree.nameByPid.get(p)
        if (comm && def.matchProcess(comm.toLowerCase())) {
          // drop() invalidates the captured state object. This prevents a
          // pre-drop snapshot from registering into a reused terminal id.
          if (terminalStates.get(terminalId) !== terminalState) return
          if (agentId === 'hermes') {
            const incoming = { sourcePid: pid, sourceStartedAt: canonicalStartedAt }
            const highWater = terminalState.hermesHighWater
            const order = highWater
              ? compareAgentProcessGeneration(incoming, highWater)
              : null
            if (order === -1) return
            if (!highWater || order === 1) terminalState.hermesHighWater = incoming
          }
          // A second post can complete its own snapshot while this await is in
          // flight. Re-check before committing so reverse completion order can
          // never let an older Hermes generation overwrite the newer one.
          const current = registrations.get(terminalId)
          if (current && shouldRetainExisting(current, agentId, pid, kind, canonicalStartedAt)) return
          registrations.set(terminalId, {
            agentId,
            pid: p,
            sourcePid: pid,
            sourceStartedAt: canonicalStartedAt,
            comm,
          })
          return
        }
      }
      // No matching ancestor (matcher miss, or the chain died before the
      // snapshot): leave nothing registered — a wrong pid (a shell, a tmux
      // server) would never fall, which is worse than reading absent.
    },

    presenceFor(terminalId, tree) {
      const reg = registrations.get(terminalId)
      if (!reg) return { agentName: null, agentPresent: false }
      if (tree.nameByPid.get(reg.pid) === reg.comm) {
        const def = AGENTS.find((a) => a.id === reg.agentId)
        return { agentName: def?.displayName ?? null, agentPresent: true }
      }
      // Pid gone (or recycled under a different comm) — the falling edge.
      // The next agent run re-registers itself through fresh hook posts.
      registrations.delete(terminalId)
      return {
        agentName: null,
        agentPresent: false,
        endedAgentPid: reg.pid,
        ...(reg.sourceStartedAt !== undefined
          ? { endedAgentStartedAt: reg.sourceStartedAt }
          : {}),
      }
    },

    drop(terminalId) {
      registrations.delete(terminalId)
      terminalStates.delete(terminalId)
    },
  }
}
