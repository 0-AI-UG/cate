// =============================================================================
// Agent CLI hooks — the renderer's one consumer-facing hook-readiness API.
//
// The runtime owns hook installation, inspection, ingestion, and normalization.
// This adapter is the only renderer module that talks to that runtime API. It
// joins the live workspace state to the canonical agent registry, preserves the
// registry's deterministic order, and owns driver-agent selection.
// =============================================================================

import { AGENTS, type AgentDef } from '../../../shared/agents'
import type { AgentHookAgentState } from '../../../shared/agentHooks'
import {
  resolveAgentHookMode,
  type AgentHookConfig,
} from '../../../shared/agentHookModes'

export interface AgentCliHookState {
  agent: AgentDef
  folderPresent: boolean
  injected: boolean
}

export interface AgentCliHookEvaluation {
  mode: ReturnType<typeof resolveAgentHookMode>
  /** Whether a terminal spawned with this policy can rely on hooks. */
  ready: boolean
  /** Auto has no existing agent folder to opt into, so injection is skipped. */
  autoSkipped: boolean
}

export class AgentCliHookError extends Error {
  readonly settingsSection = 'agent hooks'

  constructor(
    readonly code: 'inspect-failed' | 'unknown-preference' | 'preferred-not-ready' | 'none-ready',
    message: string,
  ) {
    super(message)
    this.name = 'AgentCliHookError'
  }
}

/** Inspect all external agent CLIs in canonical registry order. */
export async function inspectAgentCliHooks(locator: string): Promise<AgentCliHookState[]> {
  let live: AgentHookAgentState[]
  try {
    live = await window.electronAPI.agentHooksInspect(locator)
  } catch (cause) {
    throw new AgentCliHookError(
      'inspect-failed',
      `Cate could not verify agent hooks in this worktree: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
  const byId = new Map(live.map((state) => [state.agentId, state]))
  return AGENTS.map((agent) => {
    const state = byId.get(agent.id)
    return {
      agent,
      folderPresent: state?.folderPresent ?? false,
      injected: state?.injected ?? false,
    }
  })
}

/** Interpret one inspection result with the same policy used by every hook
 * consumer. A fallback is the base checkout inspected for a fresh worktree. */
export function evaluateAgentCliHooks(
  state: AgentCliHookState,
  hookConfig?: AgentHookConfig,
  fallback?: AgentCliHookState,
): AgentCliHookEvaluation {
  const mode = resolveAgentHookMode(hookConfig, state.agent.id)
  const present = state.injected || state.folderPresent
  const fallbackPresent = fallback?.injected === true || fallback?.folderPresent === true
  return {
    mode,
    ready: mode === 'on' || (mode === 'auto' && (present || fallbackPresent)),
    autoSkipped: mode === 'auto' && !present && !fallbackPresent,
  }
}

/** Resolve the one CLI a driver must use.
 *
 * A configured preference is strict: silently falling back would violate the
 * user's selection. Automatic mode picks the first hook-ready CLI in canonical
 * registry order, never filesystem/API response order. */
export async function resolveDriverAgentCli(
  locator: string,
  preferredId: string,
  options: {
    /** Base checkout whose agent folders/hooks make Auto effective for a linked worktree. */
    fallbackLocator?: string
    /** The workspace override applied when the driver's terminals are created. */
    hookConfig?: AgentHookConfig
  } = {},
): Promise<AgentDef> {
  const normalized = preferredId.trim()
  const states = await inspectAgentCliHooks(locator)
  const fallbackStates = options.fallbackLocator && options.fallbackLocator !== locator
    ? await inspectAgentCliHooks(options.fallbackLocator)
    : []
  const fallbackById = new Map(fallbackStates.map((state) => [state.agent.id, state]))
  const ready = (state: AgentCliHookState): boolean =>
    // prepareWorkspace uses exactly this base-checkout fallback before the
    // terminal starts, so Auto is ready even if this new worktree has not been
    // materialized yet.
    evaluateAgentCliHooks(
      state,
      options.hookConfig,
      fallbackById.get(state.agent.id),
    ).ready
  if (normalized) {
    const preferred = AGENTS.find((agent) => agent.id === normalized)
    if (!preferred) {
      throw new AgentCliHookError(
        'unknown-preference',
        `The configured engineering agent “${normalized}” is no longer available.`,
      )
    }
    const preferredState = states.find((state) => state.agent.id === preferred.id)
    if (!preferredState || !ready(preferredState)) {
      throw new AgentCliHookError(
        'preferred-not-ready',
        `${preferred.displayName} is selected as the engineering agent, but its Cate hooks are not enabled in this worktree.`,
      )
    }
    return preferred
  }

  const first = states.find(ready)?.agent
  if (first) return first
  throw new AgentCliHookError(
    'none-ready',
    'No agent CLI has Cate hooks enabled in this worktree.',
  )
}
