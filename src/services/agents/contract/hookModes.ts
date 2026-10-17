import type { AgentId } from './registry'

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

/** THE rule for whether an agent's Cate hooks are enabled in a checkout.
 *  'on' always, 'off' never; 'auto' when the agent is in use there: its own
 *  config folder exists in the checkout or its base workspace checkout, or the
 *  terminal was launched as that agent. Hook injection and the started
 *  agent's readiness check both decide through this. */
export function agentHooksEnabled(mode: AgentHookMode, inUse: boolean): boolean {
  return mode === 'on' || (mode === 'auto' && inUse)
}

/** THE 'auto' in-use signal, shared by hook injection and started-agent
 *  readiness: a launch as that agent, or its config folder in the checkout (or
 *  the base checkout). A profile-wide install (Hermes' plugin) is not use. */
export function agentHookInUse(
  agentId: AgentId,
  signals: { folderPresent: boolean; launchedAgentId?: AgentId },
): boolean {
  return signals.launchedAgentId === agentId || signals.folderPresent
}
