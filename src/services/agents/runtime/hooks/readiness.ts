// Hook readiness per agent in a checkout, and the one driver-agent pick of a
// started agent. The same policy as injection itself (agentHookInUse/Enabled).

import {
  AGENTS,
  agentHookInUse,
  agentHooksEnabled,
  isAgentId,
  resolveAgentHookMode,
  type AgentDef,
  type AgentHookAgentState,
  type AgentHookConfig,
  type AgentHookMode,
} from '../../contract'

interface AgentCliHookState {
  agent: AgentDef
  folderPresent: boolean
  injected: boolean
}

interface AgentCliHookEvaluation {
  mode: AgentHookMode
  /** A terminal spawned with this policy can rely on hooks. */
  ready: boolean
  /** Auto has no agent folder to opt into, so injection is skipped. */
  autoSkipped: boolean
}

export class AgentCliHookError extends Error {
  constructor(
    readonly code: 'inspect-failed' | 'unknown-preference' | 'preferred-not-ready' | 'none-ready',
    message: string,
  ) {
    super(message)
    this.name = 'AgentCliHookError'
  }
}

/** Inspection results in canonical registry order. */
export async function inspectAgentCliHooks(
  inspect: (cwd: string) => Promise<AgentHookAgentState[]>,
  cwd: string,
): Promise<AgentCliHookState[]> {
  let live: AgentHookAgentState[]
  try {
    live = await inspect(cwd)
  } catch (cause) {
    throw new AgentCliHookError(
      'inspect-failed',
      `Cate could not verify agent hooks in this worktree: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
  const byId = new Map(live.map((state) => [state.agentId, state]))
  return AGENTS.map((agent) => ({
    agent,
    folderPresent: byId.get(agent.id)?.folderPresent ?? false,
    injected: byId.get(agent.id)?.injected ?? false,
  }))
}

/** One inspection result under the injection policy. `fallback` is the base
 *  checkout inspected for a fresh worktree. */
export function evaluateAgentCliHooks(
  state: AgentCliHookState,
  hookConfig?: AgentHookConfig,
  fallback?: AgentCliHookState,
): AgentCliHookEvaluation {
  const mode = resolveAgentHookMode(hookConfig, state.agent.id)
  // No launch here: Auto's pick is by checkout use.
  const inUse = agentHookInUse(state.agent.id, { folderPresent: state.folderPresent || fallback?.folderPresent === true })
  return { mode, ready: agentHooksEnabled(mode, inUse), autoSkipped: mode === 'auto' && !inUse }
}

/**
 * The one CLI a started agent uses. A configured preference is strict:
 * silently falling back would violate the user's choice. Without one, the
 * first hook-ready CLI in canonical registry order.
 */
export async function resolveDriverAgent(
  inspect: (cwd: string) => Promise<AgentHookAgentState[]>,
  cwd: string,
  preferredId: string,
  options: { fallbackCwd?: string; hookConfig?: AgentHookConfig } = {},
): Promise<AgentDef> {
  const normalized = preferredId.trim()
  const states = await inspectAgentCliHooks(inspect, cwd)
  const fallbackStates = options.fallbackCwd && options.fallbackCwd !== cwd
    ? await inspectAgentCliHooks(inspect, options.fallbackCwd)
    : []
  const fallbackById = new Map(fallbackStates.map((state) => [state.agent.id, state]))
  // Injection uses this same base-checkout fallback before the terminal
  // starts, so Auto is ready even before a new worktree has the folder.
  const ready = (state: AgentCliHookState): boolean =>
    evaluateAgentCliHooks(state, options.hookConfig, fallbackById.get(state.agent.id)).ready
  if (normalized) {
    if (!isAgentId(normalized)) {
      throw new AgentCliHookError('unknown-preference', `The configured engineering agent “${normalized}” is no longer available.`)
    }
    const preferredState = states.find((state) => state.agent.id === normalized)
    if (!preferredState || !ready(preferredState)) {
      throw new AgentCliHookError(
        'preferred-not-ready',
        `${preferredState?.agent.displayName ?? normalized} is selected as the engineering agent, but its Cate hooks are not enabled in this worktree.`,
      )
    }
    return preferredState.agent
  }
  const first = states.find(ready)?.agent
  if (first) return first
  throw new AgentCliHookError('none-ready', 'No agent CLI has Cate hooks enabled in this worktree.')
}
