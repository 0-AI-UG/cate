// The terminal-agent adapter owns conversation boundaries. Consumers listen
// for resets without interpreting CLI hooks, slash commands or session ids.
import type { AgentHookEvent, AgentSession } from '../contract'

export function createConversationResets(reset: (terminalId: string) => void) {
  const identities = new Map<string, string | null>()
  const keyOf = (session: Pick<AgentSession, 'agentId' | 'sessionId'>) => JSON.stringify([session.agentId, session.sessionId])
  const observe = (terminalId: string, session: Pick<AgentSession, 'agentId' | 'sessionId'> | null) => {
    if (!session) return
    const key = keyOf(session)
    const previous = identities.get(terminalId)
    identities.set(terminalId, key)
    if (previous && previous !== key) reset(terminalId)
  }
  return {
    observe,
    note(event: AgentHookEvent) {
      if (event.kind === 'session-title' || event.kind === 'input-submit' || !event.sessionId) return
      const key = keyOf({ agentId: event.agentId, sessionId: event.sessionId })
      if (event.conversationReset) {
        const previous = identities.get(event.terminalId)
        // Ignore late resets belonging to the session a new one replaced.
        if (previous && previous !== key) return
        if (previous) reset(event.terminalId)
        identities.set(event.terminalId, null)
      } else if (event.kind === 'session-start' || event.kind === 'turn-start'
        || event.kind !== 'session-end' && !identities.get(event.terminalId)) {
        observe(event.terminalId, { agentId: event.agentId, sessionId: event.sessionId })
      }
    },
    drop(terminalId: string) { if (identities.delete(terminalId)) reset(terminalId) },
  }
}
