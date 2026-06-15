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
  /** The todo this executor session is running (executor sessions only). */
  todoId?: string
}

/** The controller implements this so the bridge can resolve session context and
 *  report lifecycle transitions without a circular import.
 *
 *  RUN vs TURN: pi emits `agent_start`/`agent_end` once per run (one prompt), and
 *  `turn_start`/`turn_end` after EVERY tool turn within that run. Completion must
 *  key off the run (`agent_end`) — keying off a turn would finalize the executor
 *  right after its first tool call. */
export interface CateAgentBridgeHost {
  contextFor(panelId: string): CateAgentContext | null
  /** A run started (agent_start) — also fired on each turn_start for liveness. */
  onRunStart(ctx: CateAgentContext): void
  /** The whole run finished (agent_end) — the real completion signal. */
  onRunEnd(ctx: CateAgentContext): void
  onError(ctx: CateAgentContext, message: string): void
}
