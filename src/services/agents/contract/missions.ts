// Missions (`cate.codingAgent.*`): a supervisor panel spawns worker agents in
// terminals, admission limits them, and their worktree changes are applied,
// kept or discarded. Pure types and status policy.

import { AGENT_DEFS, isAgentId, type AgentId } from './registry'
import type { AgentStatus } from './session'

/** At most this many workers of one mission run at once. */
export const MAX_CONCURRENT_CODING_AGENTS = 5

/** A coding agent process Cate created and owns inside a terminal panel. */
export interface CodingAgentRun {
  id: string
  agentId: AgentId
  panelId: string
  /** Short user-facing responsibility, e.g. "Integration tests". */
  title?: string
  /** The panel (a terminal or chat) that owns and may control this run. */
  ownerPanelId: string
  prompt: string
  createdAt: number
  worktreeId?: string
  /** True only when this mission created the worktree and may discard it. */
  ownsWorktree?: boolean
  /** Wake the supervisor on actionable state changes; otherwise it must
   *  wait for this run explicitly. */
  background?: boolean
  followUps?: Array<{ prompt: string; sentAt: number }>
  endedAt?: number
  exitCode?: number
  stoppedAt?: number
  appliedAt?: number
  appliedToBranch?: string
  /** The user chose to retain the isolated branch for later. */
  keptAt?: number
}

export type CodingAgentRunStatus =
  | 'starting'
  | 'working'
  | 'waiting'
  | 'ready'
  | 'stopped'
  | 'failed'

export const ACTIVE_CODING_AGENT_STATUSES: readonly CodingAgentRunStatus[] = ['starting', 'working', 'waiting']
export const ACTIONABLE_CODING_AGENT_STATUSES: readonly CodingAgentRunStatus[] = ['waiting', 'ready', 'stopped', 'failed']

export interface CodingAgentRuntimeState {
  terminalStarted: boolean
  terminalAlive: boolean
  terminalFailed: boolean
  agentState?: AgentStatus
  agentPresent?: boolean
}

/** The one status policy for a worker. */
export function deriveCodingAgentRunStatus(
  run: CodingAgentRun,
  runtime: CodingAgentRuntimeState,
): CodingAgentRunStatus {
  if (run.stoppedAt) return 'stopped'
  if (run.endedAt) return run.exitCode === 0 ? 'ready' : 'failed'
  if (runtime.terminalFailed) return 'failed'
  if (!runtime.terminalStarted) return 'starting'
  if (!runtime.terminalAlive) return 'ready'
  switch (runtime.agentState) {
    case 'running': return 'working'
    case 'waitingForInput': return 'waiting'
    case 'finished': return 'ready'
    case 'notRunning':
    default:
      return runtime.agentPresent ? 'working' : 'starting'
  }
}

export interface CodingAgentRunSnapshot extends CodingAgentRun {
  status: CodingAgentRunStatus
  agentName: string
  cwd: string
  alive: boolean
  followUpSupported: boolean
  statusLine?: string
  failureReason?: string
}

const CODING_AGENT_TASK_PREFIX = 'Complete this coding task:\n\n'

/** Resolve an untrusted argument to the closed agent registry. */
export function parseCodingAgentId(value: unknown): AgentId | null {
  return isAgentId(value) ? value : null
}

/**
 * The exact executable + argv of a mission worker's PTY. No shell is involved,
 * so task text cannot become shell syntax, and prefixing the positional task
 * prevents option or subcommand injection into the CLI's argv parser. Every
 * executable comes from the registry; callers cannot provide a path or flags.
 */
export function codingAgentCommand(launch: { agentId: AgentId; prompt: string }): { executable: string; args: string[] } {
  const agent = AGENT_DEFS[launch.agentId]
  if (!agent) throw new Error(`Unsupported coding agent: ${launch.agentId}`)
  const prompt = launch.prompt.trim()
  if (!prompt) throw new Error('A coding-agent prompt is required')
  if (prompt.includes('\0')) throw new Error('Coding-agent prompts cannot contain NUL bytes')
  return {
    executable: agent.runners.terminal.command,
    args: agent.runners.terminal.missionArgs(`${CODING_AGENT_TASK_PREFIX}${prompt}`),
  }
}

export function codingAgentSupportsFollowUp(agentId: AgentId): boolean {
  return AGENT_DEFS[agentId]?.runners.terminal.followUp ?? false
}

/** Routine lifecycle calls return this compact view instead of replaying the
 *  original task and follow-up history into the supervisor's context. */
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

export type CompactCodingAgentSnapshot = ReturnType<typeof compactCodingAgentSnapshot>

export function actionableCodingAgentRunIds(runs: readonly CodingAgentRunSnapshot[]): string[] {
  return runs.filter((run) => ACTIONABLE_CODING_AGENT_STATUSES.includes(run.status)).map((run) => run.id)
}

/** Only actionable status transitions wake the supervisor. Terminal output
 *  changes continuously and starting -> working is normal progress; waking
 *  for either would recreate the token-heavy poll loop. */
export function changedCodingAgentRunIds(
  baseline: ReadonlyMap<string, CodingAgentRunStatus>,
  runs: readonly CodingAgentRunSnapshot[],
): string[] {
  return runs
    .filter((run) => baseline.get(run.id) !== run.status && ACTIONABLE_CODING_AGENT_STATUSES.includes(run.status))
    .map((run) => run.id)
}
