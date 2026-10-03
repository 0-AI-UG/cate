import type { AgentId } from './registry'

/** One visible turn of an agent conversation. Tool calls, reasoning, injected
 *  context and other machine records are deliberately not messages. */
export interface AgentConversationMessage {
  role: 'user' | 'assistant'
  text: string
  /** ISO timestamp, when the session store records one. */
  createdAt?: string
}

/** What identifies one agent CLI session on the runtime host that ran it.
 *  Hook events carry the transcript path for some CLIs; a persisted resume
 *  stamp does not, so every session store also locates a session from
 *  `sessionId` (+ `cwd`). */
export interface AgentSessionLocator {
  agentId: AgentId
  sessionId: string
  cwd?: string
  profile?: string
  transcriptPath?: string
}
