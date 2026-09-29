import type { AgentConversationMessage, AgentSessionLocator } from '../../../shared/agentConversation'
import type { AgentId } from '../../../shared/agents'

export type { AgentSessionLocator }

/** Everything a CLI-specific store may use. `homeDir` belongs to the runtime
 *  host, so local, SSH, and WSL terminals all resolve against the right store. */
export interface AgentSessionContext {
  session: AgentSessionLocator
  homeDir: string
}

/** One agent CLI's own session persistence, read-only. Both reads are
 *  best-effort: a missing, partial, or changing store resolves null. */
export interface AgentSessionStore {
  /** The title that CLI shows in its own session picker. */
  title(context: AgentSessionContext): Promise<string | null>
  /** The visible user/assistant turns, in conversation order. */
  conversation(context: AgentSessionContext): Promise<AgentConversationMessage[] | null>
}

/** Exhaustive by design: adding a supported CLI must say where its sessions
 *  live instead of silently having no title or conversation. */
export type AgentSessionStores = Record<AgentId, AgentSessionStore>
