// =============================================================================
// cateAgentTypes — shared interfaces between the bridge, tools, and controller,
// kept in a leaf module so none of them import each other for a type.
// =============================================================================

import type { CateAgentRole } from '../../shared/types'

/** Everything a Cate Agent tool needs to know about the session that called it. */
export interface CateAgentContext {
  panelId: string
  workspaceId: string
  /** Workspace locator / root path (the agent cwd). */
  rootPath: string
  role: CateAgentRole
  /** The todo this orchestrator/driver session is working on. */
  todoId?: string
  /** Monotonic run token (orchestrator only). A todo can be stopped and restarted
   *  (editJob) reusing the same todoId/panelId; the epoch distinguishes the new
   *  run from the old, so an in-flight wake/continuation from the old run bails
   *  instead of driving the new one. */
  epoch?: number
  // --- driver-only fields (one driver per iteration; see codingAgentLauncher) ---
  /** The iteration this driver is executing (work driver) or checking (verifier). */
  iterationId?: string
  /** Whether this driver runs the iteration's work or its verification — its
   *  create_terminal terminals are recorded on the iteration only for 'work'. */
  driverKind?: 'work' | 'verify'
  /** Worktree cwd the driver's terminals open in (create_terminal has no cwd of
   *  its own — it always opens in the iteration's worktree). */
  cwd?: string
  /** Glow color for the driver's controlled terminals. */
  glow?: string
  /** Worktree the driver's terminals belong to (for the panel's worktree tag). */
  worktreeId?: string
}

/** The controller implements this so the bridge can resolve session context and
 *  report lifecycle transitions without a circular import.
 *
 *  RUN vs TURN: pi emits `agent_start`/`agent_end` once per run (one prompt), and
 *  `turn_start`/`turn_end` after EVERY tool turn within that run. Completion must
 *  key off the run (`agent_end`) — keying off a turn would finalize the orchestrator
 *  right after its first tool call. */
export interface CateAgentBridgeHost {
  contextFor(panelId: string): CateAgentContext | null
  /** A run started (agent_start) — also fired on each turn_start for liveness. */
  onRunStart(ctx: CateAgentContext): void
  /** The whole run finished (agent_end) — the real completion signal. */
  onRunEnd(ctx: CateAgentContext): void
  onError(ctx: CateAgentContext, message: string): void
}
