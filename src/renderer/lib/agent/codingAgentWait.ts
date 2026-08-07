import type { CodingAgentRunSnapshot } from '../../../shared/codingAgentRuns'

export const DEFAULT_CODING_AGENT_WAIT_SECONDS = 10
export const MIN_CODING_AGENT_WAIT_SECONDS = 5
export const MAX_CODING_AGENT_WAIT_SECONDS = 60

/** Routine lifecycle calls return this compact view instead of replaying the
 * original task and follow-up history into the supervisor's context. */
export function compactCodingAgentSnapshot(snapshot: CodingAgentRunSnapshot) {
  return {
    id: snapshot.id,
    agentId: snapshot.agentId,
    agentName: snapshot.agentName,
    ...(snapshot.title ? { title: snapshot.title } : {}),
    panelId: snapshot.panelId,
    status: snapshot.status,
    cwd: snapshot.cwd,
    alive: snapshot.alive,
    followUpSupported: snapshot.followUpSupported,
    ...(snapshot.worktreeId ? { worktreeId: snapshot.worktreeId } : {}),
    ...(snapshot.ownsWorktree ? { ownsWorktree: true } : {}),
    background: snapshot.background !== false,
    ...(snapshot.appliedAt ? {
      appliedAt: snapshot.appliedAt,
      appliedToBranch: snapshot.appliedToBranch,
    } : {}),
    ...(snapshot.keptAt ? { keptAt: snapshot.keptAt } : {}),
    ...(snapshot.statusLine ? { statusLine: snapshot.statusLine } : {}),
    ...(snapshot.failureReason ? { failureReason: snapshot.failureReason } : {}),
  }
}

export function codingAgentWaitMs(value: unknown): number {
  const requested = Number(value ?? DEFAULT_CODING_AGENT_WAIT_SECONDS)
  const seconds = Number.isFinite(requested)
    ? Math.max(MIN_CODING_AGENT_WAIT_SECONDS, Math.min(MAX_CODING_AGENT_WAIT_SECONDS, requested))
    : DEFAULT_CODING_AGENT_WAIT_SECONDS
  return seconds * 1_000
}

export function actionableCodingAgentRunIds(runs: CodingAgentRunSnapshot[]): string[] {
  return runs
    .filter((run) =>
      run.status === 'waiting' ||
      run.status === 'ready' ||
      run.status === 'stopped' ||
      run.status === 'failed',
    )
    .map((run) => run.id)
}

/** Only actionable status transitions should wake the supervisor. Terminal
 * output changes continuously, and starting → working is normal progress;
 * waking for either would recreate the token-heavy poll loop. */
export function changedCodingAgentRunIds(
  baseline: ReadonlyMap<string, CodingAgentRunSnapshot['status']>,
  runs: CodingAgentRunSnapshot[],
): string[] {
  return runs
    .filter((run) =>
      baseline.get(run.id) !== run.status &&
      (run.status === 'waiting' ||
        run.status === 'ready' ||
        run.status === 'stopped' ||
        run.status === 'failed'),
    )
    .map((run) => run.id)
}
