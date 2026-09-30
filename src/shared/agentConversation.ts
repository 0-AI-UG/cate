import { AGENTS, type AgentId } from './agents'

/** One visible turn of an agent conversation. Tool calls, reasoning, injected
 *  context and other machine records are deliberately not messages. */
export interface AgentConversationMessage {
  role: 'user' | 'assistant'
  text: string
  /** ISO timestamp, when the session store records one. */
  createdAt?: string
}

/** One agent session, whichever surface hosts it. A terminal session is an
 *  agent CLI in a Cate terminal, identified by that CLI's own session id and
 *  read from that CLI's session store. A T3 session is a T3 Code thread (the
 *  thread id is its session id), read from the T3 harness. */
export interface AgentSessionRef {
  host: 'terminal' | 't3'
  /** The agent CLI behind the session. For T3, the provider of the thread's
   *  session; null until the thread has started one. */
  agentId: AgentId | null
  sessionId: string
  cwd: string
  profile?: string
}

/** What identifies one agent CLI session on the runtime host that ran it.
 *  Hook events carry the transcript path for some CLIs; a persisted session
 *  stamp does not, so every session store must also locate a session from
 *  `sessionId` (+ `cwd`). */
export interface AgentSessionLocator {
  agentId: AgentId
  sessionId: string
  cwd?: string
  profile?: string
  transcriptPath?: string
}

/** Validate a locator arriving over the runtime wire. Throws on bad input. */
export function parseAgentSessionLocator(value: unknown): AgentSessionLocator {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const optional = (key: string): string | undefined => {
    const field = v[key]
    if (field === undefined || field === null) return undefined
    if (typeof field !== 'string') throw new Error(`invalid agent session ${key}`)
    return field
  }
  const agent = AGENTS.find((candidate) => candidate.id === v.agentId)
  if (!agent) throw new Error('unknown agent')
  if (typeof v.sessionId !== 'string' || !v.sessionId) throw new Error('invalid agent session id')
  return {
    agentId: agent.id,
    sessionId: v.sessionId,
    cwd: optional('cwd'),
    profile: optional('profile'),
    transcriptPath: optional('transcriptPath'),
  }
}

export interface AgentConversation {
  session: AgentSessionRef
  messages: AgentConversationMessage[]
}
