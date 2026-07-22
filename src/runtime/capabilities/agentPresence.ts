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
import type { ProcTree } from './procfs'

export interface AgentPresence {
  agentName: string | null
  agentPresent: boolean
}

export interface AgentPresenceTracker {
  /** Ingest one authenticated hook post's lineage claim. Resolves (and
   *  re-resolves after an agent relaunch) the registered agent pid for the
   *  terminal. Await it before answering the post — the bridge's ancestry
   *  chain is only guaranteed alive while the post is in flight. */
  notePost(terminalId: string, agentId: AgentId, pid: number | undefined): Promise<void>
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
  /** comm at registration time — presenceFor requires it unchanged, so a
   *  recycled pid can't impersonate the agent. */
  comm: string
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

  return {
    async notePost(terminalId, agentId, pid) {
      // Reject anything that isn't a plain positive pid: posts are made by
      // processes inside the terminal, so the value is untrusted input (and
      // pid 0 / negatives address process GROUPS in kill()).
      if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return
      const def = AGENTS.find((a) => a.id === agentId)
      if (!def) return

      // Fast path: this terminal's agent is already registered and alive —
      // the common per-tool-call event needs no snapshot.
      const existing = registrations.get(terminalId)
      if (existing && existing.agentId === agentId && isAlive(existing.pid)) return

      const tree = await deps.snapshot()
      const parent = parentMap(tree)
      const visited = new Set<number>()
      // Inclusive walk: an in-process plugin posts the agent's own pid; the
      // bridge posts its parent (possibly with sh/npm layers above it).
      for (let p: number | undefined = pid; p !== undefined && !visited.has(p); p = parent.get(p)) {
        visited.add(p)
        const comm = tree.nameByPid.get(p)
        if (comm && def.matchProcess(comm.toLowerCase())) {
          registrations.set(terminalId, { agentId, pid: p, comm })
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
      return { agentName: null, agentPresent: false }
    },

    drop(terminalId) {
      registrations.delete(terminalId)
    },
  }
}
