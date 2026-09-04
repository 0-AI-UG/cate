import type { AgentHookEvent } from '../../../shared/agentHooks'
import type { AgentId } from '../../../shared/agents'

/** Everything a CLI-specific resolver may use to find the title that CLI
 * persists for its own session picker. `homeDir` belongs to the runtime host,
 * so local, SSH, and WSL terminals all resolve against the correct store. */
export interface AgentTitleResolverContext {
  event: AgentHookEvent
  homeDir: string
}

export type AgentTitleResolver = (
  context: AgentTitleResolverContext,
) => Promise<string | null>

/** Exhaustive by design: adding a supported CLI must choose how its native
 * session title is resolved instead of silently falling back forever. */
export type AgentTitleResolvers = Record<AgentId, AgentTitleResolver>
