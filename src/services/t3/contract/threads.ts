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

/** The fields Cate keeps from one of T3's thread shells. */
export function pickT3Thread(thread: Record<string, unknown>): T3Thread {
  return {
    id: String(thread.id),
    title: String(thread.title ?? ''),
    latestTurn: thread.latestTurn as T3Thread['latestTurn'],
    session: thread.session as T3Thread['session'],
    hasPendingApprovals: thread.hasPendingApprovals as boolean | undefined,
    hasPendingUserInput: thread.hasPendingUserInput as boolean | undefined,
    hasActionableProposedPlan: thread.hasActionableProposedPlan as boolean | undefined,
    backgroundLiveness: thread.backgroundLiveness as T3Thread['backgroundLiveness'],
  }
}

/** Folds one `orchestration.subscribeShell` event into a snapshot. */
export function applyT3ShellEvent(state: T3ShellSnapshot, event: Record<string, any>): T3ShellSnapshot {
  let next = state
  if (event.kind === 'snapshot') {
    const threads: Array<Record<string, unknown>> = event.snapshot?.threads ?? []
    next = {
      ...state,
      threads: Object.fromEntries(threads.map((thread) => [String(thread.id), pickT3Thread(thread)])),
      sequence: event.snapshot?.snapshotSequence ?? state.sequence,
      connected: true,
    }
  } else if (event.kind === 'thread-upserted' && event.thread) {
    next = { ...state, threads: { ...state.threads, [String(event.thread.id)]: pickT3Thread(event.thread) } }
  } else if (event.kind === 'thread-removed') {
    const { [String(event.threadId)]: _removed, ...rest } = state.threads
    next = { ...state, threads: rest }
  }
  return typeof event.sequence === 'number' ? { ...next, sequence: event.sequence } : next
}

/** Applies a pushed snapshot over the one held, keeping unchanged thread
 *  objects referentially stable (so selectors over one thread do not re-render
 *  on unrelated updates). Returns `previous` when nothing changed or the
 *  snapshot is older. */
export function mergeT3ShellSnapshot(previous: T3ShellSnapshot | undefined, snapshot: T3ShellSnapshot): T3ShellSnapshot {
  if (!previous) return snapshot
  if (snapshot.sequence < previous.sequence) return previous
  const threads = Object.fromEntries(Object.entries(snapshot.threads).map(([id, thread]) => {
    const old = previous.threads[id]
    return [id, old && JSON.stringify(old) === JSON.stringify(thread) ? old : thread]
  }))
  const same = previous.connected === snapshot.connected
    && previous.sequence === snapshot.sequence
    && Object.keys(previous.threads).length === Object.keys(threads).length
    && Object.entries(threads).every(([id, thread]) => previous.threads[id] === thread)
  return same ? previous : { ...snapshot, threads }
}

/** Whether any thread of the snapshot is running a turn. */
export function t3SnapshotBusy(snapshot: T3ShellSnapshot): boolean {
  return snapshot.connected && Object.values(snapshot.threads).some((thread) => t3ThreadActivity(thread) === 'running')
}
