// Starting an agent (`cate.agent.start`): what the CLI runs in a terminal in
// place of the shell, and the agent CLIs a start can pick. Pure.

import type { T3ProviderId } from '@services/t3/contract'
import { AGENT_DEFS, type AgentId } from './registry'

/** An agent CLI a start can pick (`cate.agent.types`). */
export interface AgentTypeInfo {
  agentId: AgentId
  displayName: string
  /** Its Cate hooks are on here, so it can start in a terminal. */
  ready: boolean
  /** The T3 provider it runs as in T3; null when T3 cannot run it. */
  t3Provider: T3ProviderId | null
}

const AGENT_TASK_PREFIX = 'Complete this coding task:\n\n'

/**
 * The exact executable + argv of a started agent's PTY. No shell is involved,
 * so prompt text cannot become shell syntax, and prefixing the positional
 * prompt prevents option or subcommand injection into the CLI's argv parser.
 * Every executable comes from the registry; callers cannot provide a path or
 * flags.
 */
export function agentLaunchCommand(launch: { agentId: AgentId; prompt: string }): { executable: string; args: string[] } {
  const agent = AGENT_DEFS[launch.agentId]
  if (!agent) throw new Error(`Unsupported agent: ${launch.agentId}`)
  const prompt = launch.prompt.trim()
  if (!prompt) throw new Error('A prompt is required')
  if (prompt.includes('\0')) throw new Error('Prompts cannot contain NUL bytes')
  return {
    executable: agent.runners.terminal.command,
    args: agent.runners.terminal.promptArgs(`${AGENT_TASK_PREFIX}${prompt}`),
  }
}

/** A started agent's first prompt as the person wrote it, without the prefix
 *  its launch added (`agentLaunchCommand`). */
export function agentTaskText(text: string): string {
  return text.startsWith(AGENT_TASK_PREFIX) ? text.slice(AGENT_TASK_PREFIX.length) : text
}
