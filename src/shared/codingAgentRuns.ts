import { AGENTS, type AgentId } from './agents'

/** A coding agent process Cate created and owns inside a terminal panel. */
export interface CodingAgentRun {
  id: string
  agentId: AgentId
  panelId: string
  prompt: string
  createdAt: number
  worktreeId?: string
  /** Follow-up prompts sent after the initial task. Kept with panel state so
   *  mission context survives a Cate restart. */
  followUps?: Array<{ prompt: string; sentAt: number }>
  endedAt?: number
  exitCode?: number
  stoppedAt?: number
}

/** One-shot launch data consumed when the terminal's PTY is first spawned. */
export interface CodingAgentLaunch {
  runId: string
  agentId: AgentId
  prompt: string
}

export type CodingAgentRunStatus =
  | 'starting'
  | 'working'
  | 'waiting'
  | 'ready'
  | 'stopped'
  | 'failed'

export interface CodingAgentRunSnapshot extends CodingAgentRun {
  status: CodingAgentRunStatus
  agentName: string
  cwd: string
  alive: boolean
  /** OpenCode's prompt-bearing `run` surface is one-shot; the other registered
   *  interactive CLIs can accept follow-up prompts in the same terminal. */
  followUpSupported: boolean
  statusLine?: string
}

export const MAX_CONCURRENT_CODING_AGENTS = 5

/** Resolve an untrusted tool argument to the closed, canonical agent registry. */
export function parseCodingAgentId(value: unknown): AgentId | null {
  if (typeof value !== 'string') return null
  return AGENTS.some((agent) => agent.id === value) ? (value as AgentId) : null
}

/**
 * Build the exact executable + argv for a Cate-owned coding-agent PTY.
 *
 * No shell is involved, so task text cannot become shell syntax. Every
 * executable comes from AGENTS; callers cannot provide a path or extra flags.
 * OpenCode's prompt-bearing surface is its `run` command. Other supported CLIs
 * accept the first positional prompt while remaining interactive.
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
    args: launch.agentId === 'opencode' ? ['run', prompt] : [prompt],
  }
}

export function codingAgentDisplayName(agentId: AgentId): string {
  return AGENTS.find((agent) => agent.id === agentId)?.displayName ?? agentId
}
