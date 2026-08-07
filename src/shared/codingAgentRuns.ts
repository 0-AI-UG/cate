import { AGENTS, type AgentId } from './agents'

/** A coding agent process Cate created and owns inside a terminal panel. */
export interface CodingAgentRun {
  id: string
  agentId: AgentId
  panelId: string
  /** Short user-facing responsibility, e.g. “Integration tests”. */
  title?: string
  /** Cate Agent panel/session that owns and may control this run. */
  ownerPanelId: string
  prompt: string
  createdAt: number
  worktreeId?: string
  /** True only when this mission created the worktree and may offer discard. */
  ownsWorktree?: boolean
  /** When true, Cate wakes the owning supervisor on actionable state changes.
   *  When false, the supervisor must wait for this run explicitly. */
  background?: boolean
  /** Follow-up prompts sent after the initial task. Kept with panel state so
   *  mission context survives a Cate restart. */
  followUps?: Array<{ prompt: string; sentAt: number }>
  endedAt?: number
  exitCode?: number
  stoppedAt?: number
  appliedAt?: number
  appliedToBranch?: string
  /** User explicitly chose to retain the isolated branch for later. */
  keptAt?: number
}

/** One-shot launch data consumed when the terminal's PTY is first spawned. */
export interface CodingAgentLaunch {
  runId: string
  agentId: AgentId
  title?: string
  prompt: string
  ownerPanelId: string
  ownsWorktree?: boolean
  background?: boolean
}

export type CodingAgentRunStatus =
  | 'starting'
  | 'working'
  | 'waiting'
  | 'ready'
  | 'stopped'
  | 'failed'

export interface CodingAgentRuntimeState {
  terminalStarted: boolean
  terminalAlive: boolean
  terminalFailed: boolean
  agentState?: 'notRunning' | 'running' | 'waitingForInput' | 'finished'
  agentPresent?: boolean
}

/** One status policy shared by the renderer supervisor and the cross-window
 * discovery report. Keeping this pure prevents detached-worker waits from
 * interpreting the same terminal differently. */
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
  /** Derived from the canonical agent capability registry. */
  followUpSupported: boolean
  statusLine?: string
  failureReason?: string
}

export const MAX_CONCURRENT_CODING_AGENTS = 5
const CODING_AGENT_TASK_PREFIX = 'Complete this coding task:\n\n'

/** Resolve an untrusted tool argument to the closed, canonical agent registry. */
export function parseCodingAgentId(value: unknown): AgentId | null {
  if (typeof value !== 'string') return null
  return AGENTS.some((agent) => agent.id === value) ? (value as AgentId) : null
}

/**
 * Build the exact executable + argv for a Cate-owned coding-agent PTY.
 *
 * No shell is involved, so task text cannot become shell syntax. Prefixing the
 * positional task also prevents option/subcommand injection into the CLI's own
 * argv parser. Every executable comes from AGENTS; callers cannot provide a
 * path or extra flags. OpenCode's prompt-bearing surface is its `run` command.
 */
export function codingAgentCommand(
  launch: Pick<CodingAgentLaunch, 'agentId' | 'prompt'>,
): { executable: string; args: string[] } {
  const agent = AGENTS.find((candidate) => candidate.id === launch.agentId)
  if (!agent) throw new Error(`Unsupported coding agent: ${launch.agentId}`)
  const prompt = launch.prompt.trim()
  if (!prompt) throw new Error('A coding-agent prompt is required')
  if (prompt.includes('\0')) throw new Error('Coding-agent prompts cannot contain NUL bytes')
  return {
    executable: agent.command,
    args: agent.codingAgentArgs(`${CODING_AGENT_TASK_PREFIX}${prompt}`),
  }
}

export function codingAgentDisplayName(agentId: AgentId): string {
  return AGENTS.find((agent) => agent.id === agentId)?.displayName ?? agentId
}

export function codingAgentSupportsFollowUp(agentId: AgentId): boolean {
  return AGENTS.find((agent) => agent.id === agentId)?.codingAgentFollowUp ?? false
}
