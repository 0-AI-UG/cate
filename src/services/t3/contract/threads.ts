import type { T3ShellSnapshot, T3Thread, T3ThreadActivity } from './types'

export function t3ThreadActivity(thread: T3Thread): T3ThreadActivity {
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

/** Whether any thread of the snapshot is running a turn. */
export function t3SnapshotBusy(snapshot: T3ShellSnapshot): boolean {
  return snapshot.connected && Object.values(snapshot.threads).some((thread) => t3ThreadActivity(thread) === 'running')
}
