import type { AgentState } from '../../shared/types'
import type { T3Thread } from '../../shared/t3Agent'

export type { T3Thread } from '../../shared/t3Agent'

export function t3ThreadActivity(thread: T3Thread): AgentState {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput || thread.hasActionableProposedPlan) return 'waitingForInput'
  if (thread.session?.status === 'starting' || thread.latestTurn?.state === 'running' || thread.session?.activeTurnId || thread.backgroundLiveness) return 'running'
  // A stopped turn leaves the conversation ready for the user's next message,
  // just like a terminal agent returning to its prompt.
  return thread.latestTurn ? 'waitingForInput' : 'notRunning'
}

export function canT3ThreadReceivePrompt(thread: T3Thread): boolean {
  return !thread.hasPendingApprovals
    && !thread.hasPendingUserInput
    && !thread.hasActionableProposedPlan
    && t3ThreadActivity(thread) !== 'running'
}
