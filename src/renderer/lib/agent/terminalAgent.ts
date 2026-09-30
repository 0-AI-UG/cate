import { AGENTS, matchAgentDef, type AgentDef, type AgentId } from '../../../shared/agents'
import type { TerminalActivity } from '../../../shared/types'

/** The agent CLI open in a terminal, from one scan result. An agent is open
 *  from launch, before its first prompt: either its hooks proved it (claude
 *  and cursor at launch, hermes when it loads Cate's plugin), or the
 *  terminal's foreground program is its command (codex, grok, opencode and
 *  kiro fire no hook until the first prompt). useProcessMonitor applies this
 *  once per scan, so every consumer reads it as `agentPresent`/`agentId`. */
export function openTerminalAgent(
  activity: TerminalActivity,
  hookAgentId: AgentId | null,
  hookPresent: boolean,
): AgentDef | null {
  if (hookPresent) return AGENTS.find((agent) => agent.id === hookAgentId) ?? null
  return activity.type === 'running' && activity.processName ? matchAgentDef(activity.processName) : null
}

/** The open agent recorded for a terminal in statusStore. */
export function terminalAgent(
  status: { agentPresent: boolean; agentId: AgentId | null } | undefined,
): AgentDef | null {
  return status?.agentPresent ? AGENTS.find((agent) => agent.id === status.agentId) ?? null : null
}
