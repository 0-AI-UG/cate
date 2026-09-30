// =============================================================================
// Agent conversations — one read path for every agent surface. A panel's
// AgentSessionRef (published by its owner window) says where the session lives:
// a terminal CLI session is read by the workspace's runtime from that CLI's own
// session store (runtime/capabilities/agentSessions), a T3 thread from the T3
// server's thread API. Neither needs the panel's window or guest page.
// =============================================================================

import type { AgentConversationMessage, AgentSessionRef } from '../shared/agentConversation'
import { resolveLocator } from './runtime/runtimeManager'
import { t3HarnessManager } from './t3Agent/T3HarnessManager'

export async function readAgentConversation(
  session: AgentSessionRef,
  workspaceId: string,
  ownerWindowId: number,
): Promise<AgentConversationMessage[] | null> {
  if (session.host === 't3') {
    return t3HarnessManager.readConversation(
      { workspaceId, cwd: session.cwd, threadId: session.sessionId },
      ownerWindowId,
    )
  }
  if (!session.agentId) return null
  const { runtime, path } = resolveLocator(session.cwd)
  return runtime.agentHooks.readConversation({
    agentId: session.agentId,
    sessionId: session.sessionId,
    cwd: path,
    ...(session.profile ? { profile: session.profile } : {}),
  })
}
