import type { AgentId } from './registry'
import type { AgentStatus } from './session'

/** One visible turn of an agent conversation. Tool calls, reasoning, injected
 *  context and other machine records are deliberately not messages. */
export interface AgentConversationMessage {
  role: 'user' | 'assistant'
  text: string
  /** ISO timestamp, when the session store records one. */
  createdAt?: string
  /** The text is still coming in (a T3 reply mid-turn). */
  streaming?: true
}

/** A panel's agent conversation as the `agents.conversation` channel carries
 *  it: the messages and the agent's state, read together, so a turn that
 *  ended arrives with its reply. A message's id is its index. */
export interface AgentConversation {
  /** Null while the panel hosts no agent. */
  status: AgentStatus | null
  canReceivePrompt: boolean
  messages: AgentConversationMessage[]
}

/** A change to an `AgentConversation`: the messages from index `from` on are
 *  replaced by `messages` (a reply growing, a turn appended). */
export interface AgentConversationChange {
  status?: AgentStatus | null
  canReceivePrompt?: boolean
  from?: number
  messages?: AgentConversationMessage[]
}

const sameMessage = (a: AgentConversationMessage, b: AgentConversationMessage): boolean =>
  a.role === b.role && a.text === b.text && a.createdAt === b.createdAt && a.streaming === b.streaming

/** The change from `before` to `after`, or null when nothing changed. */
export function diffAgentConversation(before: AgentConversation, after: AgentConversation): AgentConversationChange | null {
  const change: AgentConversationChange = {}
  if (before.status !== after.status) change.status = after.status
  if (before.canReceivePrompt !== after.canReceivePrompt) change.canReceivePrompt = after.canReceivePrompt
  let from = 0
  const shared = Math.min(before.messages.length, after.messages.length)
  while (from < shared && sameMessage(before.messages[from], after.messages[from])) from++
  if (from < before.messages.length || from < after.messages.length) {
    change.from = from
    change.messages = after.messages.slice(from)
  }
  return Object.keys(change).length > 0 ? change : null
}

export function applyAgentConversationChange(conversation: AgentConversation, change: AgentConversationChange): AgentConversation {
  return {
    status: change.status !== undefined ? change.status : conversation.status,
    canReceivePrompt: change.canReceivePrompt ?? conversation.canReceivePrompt,
    messages: change.from !== undefined
      ? [...conversation.messages.slice(0, change.from), ...(change.messages ?? [])]
      : conversation.messages,
  }
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
