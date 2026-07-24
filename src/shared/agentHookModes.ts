import type { AgentId } from './agents'

/** Per-agent workspace hook-file preference. */
export type AgentHookMode = 'auto' | 'on' | 'off'

/** Sparse per-agent overrides; any agent absent resolves to 'auto'. */
export type AgentHookConfig = Partial<Record<AgentId, AgentHookMode>>

/** The effective mode for one agent (missing → 'auto'). */
export function resolveAgentHookMode(
  config: AgentHookConfig | undefined,
  agentId: AgentId,
): AgentHookMode {
  return config?.[agentId] ?? 'auto'
}
