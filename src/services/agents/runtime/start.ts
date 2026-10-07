// Starting an agent (`cate.agent.start`): its CLI in a new terminal panel, or
// a T3 Code thread in a new chat panel, in the caller's checkout or a
// worktree, next to the caller unless told where. Once started it is an agent
// like any other: `cate.agent.*` talks to it by its panel. Panels, worktrees
// and T3 come through injected ports, since they live in other modules.

import { RpcError } from '@kernel/rpc/contract'
import type { Point } from '@workspace/canvas/contract'
import type { PlaceTarget } from '@workspace/document/contract'
import type { T3ProviderModels, T3StartThreadParams } from '@services/t3/contract'
import { AGENT_LAUNCH, AGENTS, AGENT_DEFS, isAgentId, type AgentId, type AgentRunner, type AgentTypeInfo } from '../contract'
import type { AgentsRuntime } from './agentsRuntime'
import { evaluateAgentCliHooks, inspectAgentCliHooks, resolveDriverAgent } from './hooks/readiness'

/** Where a new panel goes: an explicit target, or near a panel (on its
 *  canvas when it is a canvas panel or sits on one), at a canvas point. */
export interface AgentPlacement {
  at?: PlaceTarget
  near?: string
  position?: Point
}

/** A launch the terminal service resolves (a registered launch intent). */
export interface AgentTerminalLaunch {
  kind: string
  params: unknown
}

export interface AgentStartPorts {
  terminals: {
    /** A new terminal panel running `launch`; resolves once its PTY started. */
    create(params: { cwd: string; worktreeId?: string; title: string; launch: AgentTerminalLaunch; placement: AgentPlacement }): Promise<string>
    /** Restarts an existing terminal panel's PTY with `launch`. */
    relaunch(panelId: string, params: { cwd: string; worktreeId?: string; launch: AgentTerminalLaunch }): Promise<void>
    /** A terminal panel's PTY, or null for a panel that is no terminal. */
    state(panelId: string): { alive: boolean; busy: boolean } | null
  }
  /** A new chat panel showing T3 thread `threadId`; null when it could not
   *  be placed. */
  createChat(params: { threadId: string; cwd?: string; worktreeId?: string; title?: string; placement: AgentPlacement }): string | null
  worktrees: {
    create(name: string): Promise<{ id: string; path: string }>
    /** Removes a worktree this start created, when the start failed. */
    remove(worktreeId: string): Promise<void>
  }
  t3: {
    providerModels(): Promise<T3ProviderModels[]>
    startThread(params: T3StartThreadParams): Promise<{ threadId: string }>
  }
}

export interface AgentStartArgs {
  prompt: string
  agentId?: string
  runner?: AgentRunner
  /** T3: the provider instance and model. */
  instanceId?: string
  model?: string
  title?: string
  worktreeId?: string
  newWorktree?: string
  /** Terminal: an existing idle terminal panel to run in instead of a new one. */
  terminalPanelId?: string
  /** Default: next to the calling panel. */
  placement?: AgentPlacement
}

export interface AgentStarter {
  /** Starts an agent for `callerPanelId` (undefined for a client); answers
   *  with the panel that hosts it. */
  start(callerPanelId: string | undefined, args: AgentStartArgs): Promise<{ panelId: string; runner: AgentRunner; agentId: AgentId | null }>
  /** Every agent CLI, in registry order. */
  types(): Promise<AgentTypeInfo[]>
}

function fail(code: string): never {
  throw new RpcError('rejected', code)
}

export function createAgentStarter(agents: AgentsRuntime, ports: AgentStartPorts): AgentStarter {
  const inspect = (dir: string) => agents.hooks.inspectWorkspace(dir)

  /** The checkout to run in: the asked worktree, else the caller's own. */
  const checkoutFor = (callerPanelId: string | undefined, worktreeId: string | undefined): { cwd: string; worktreeId?: string } => {
    if (worktreeId) {
      const cwd = agents.document.worktreePath(worktreeId)
      if (!cwd) fail('worktree-not-registered')
      return { cwd, worktreeId }
    }
    const inherited = callerPanelId ? agents.document.panel(callerPanelId)?.worktreeId : undefined
    const cwd = inherited ? agents.document.worktreePath(inherited) : undefined
    return inherited && cwd && cwd !== agents.root ? { cwd, worktreeId: inherited } : { cwd: agents.root }
  }

  /** The hook-ready agent a terminal start runs (strict for a preference). */
  const terminalAgent = async (cwd: string, preferred: AgentId | undefined): Promise<AgentId> => {
    try {
      const agent = await resolveDriverAgent(inspect, cwd, preferred ?? '', {
        fallbackCwd: agents.root,
        hookConfig: agents.settings.agentHookInjection(),
      })
      return agent.id
    } catch (error) {
      return fail(error instanceof Error ? `agent-hooks-not-ready: ${error.message}` : 'agent-hooks-not-ready')
    }
  }

  /** The T3 instance and model a chat start runs on: the asked ones, else a
   *  ready instance of the agent's provider (any, without an agent) and its
   *  default model. */
  const t3Choice = async (agentId: AgentId | undefined, instanceId: string | undefined, model: string | undefined) => {
    const providerId = agentId ? AGENT_DEFS[agentId].runners.t3?.providerId : undefined
    if (agentId && !providerId) fail('agent-not-in-t3')
    const instances = await ports.t3.providerModels()
    const instance = instances.find((candidate) => candidate.ready
      && (instanceId ? candidate.instanceId === instanceId : !providerId || candidate.providerId === providerId))
    if (!instance) return fail('t3-provider-not-ready')
    const slug = model ?? (instance.models.find((candidate) => candidate.isDefault) ?? instance.models[0])?.slug
    if (!slug) return fail('t3-model-not-found')
    const agent = AGENTS.find((candidate) => candidate.runners.t3?.providerId === instance.providerId)
    return { instanceId: instance.instanceId, model: slug, agentId: agent?.id ?? null }
  }

  const idleTerminal = (panelId: string, callerPanelId: string | undefined): void => {
    if (panelId === callerPanelId) fail('agent-cannot-replace-caller-terminal')
    const terminal = ports.terminals.state(panelId)
    if (!terminal) fail('terminal-not-found')
    if (terminal.alive && (agents.registry.sessionFor(panelId)?.present || terminal.busy)) fail('terminal-busy')
  }

  return {
    async start(callerPanelId, args) {
      agents.trust.requireTrusted()
      const prompt = args.prompt.trim()
      if (!prompt) fail('prompt-required')
      if (prompt.includes('\0')) fail('invalid-prompt')
      if (args.agentId !== undefined && !isAgentId(args.agentId)) fail('unsupported-agent')
      if (args.worktreeId && args.newWorktree) fail('choose-worktreeId-or-newWorktree')
      const runner = args.runner ?? 'terminal'
      if (args.terminalPanelId) {
        if (runner !== 'terminal') fail('terminal-requires-terminal-runner')
        idleTerminal(args.terminalPanelId, callerPanelId)
      }
      const preferred = args.agentId as AgentId | undefined
      const placement = args.placement ?? (callerPanelId ? { near: callerPanelId } : {})

      // Chosen before any worktree exists, so a refused start leaves none.
      const existing = args.newWorktree ? null : checkoutFor(callerPanelId, args.worktreeId)
      const terminalId = runner === 'terminal' ? await terminalAgent(existing?.cwd ?? agents.root, preferred) : null
      const t3 = runner === 't3' ? await t3Choice(preferred, args.instanceId, args.model) : null

      const created = args.newWorktree ? await ports.worktrees.create(args.newWorktree) : null
      const checkout = created ? { cwd: created.path, worktreeId: created.id } : existing!
      try {
        if (terminalId) {
          const launch = { kind: AGENT_LAUNCH.start, params: { agentId: terminalId, prompt } }
          if (args.terminalPanelId) {
            // Reuse the panel, not its shell process: restarting the PTY
            // launches the canonical executable and argv directly.
            void ports.terminals.relaunch(args.terminalPanelId, { ...checkout, launch }).catch(() => {})
            return { panelId: args.terminalPanelId, runner, agentId: terminalId }
          }
          const title = args.title?.trim() || prompt.replace(/\s+/g, ' ').slice(0, 54)
          const panelId = await ports.terminals.create({ ...checkout, title, launch, placement })
          return { panelId, runner, agentId: terminalId }
        }
        const inWorktree = checkout.cwd !== agents.root
        const { threadId } = await ports.t3.startThread({
          ...(inWorktree ? { checkout: checkout.cwd } : {}),
          instanceId: t3!.instanceId,
          model: t3!.model,
          text: prompt,
        })
        const panelId = ports.createChat({
          threadId,
          ...(inWorktree ? checkout : {}),
          ...(args.title?.trim() ? { title: args.title.trim() } : {}),
          placement,
        })
        if (!panelId) fail('panel-creation-failed')
        return { panelId, runner, agentId: t3!.agentId }
      } catch (error) {
        if (created) await ports.worktrees.remove(created.id).catch(() => {})
        throw error
      }
    },

    async types() {
      agents.trust.requireTrusted()
      const states = await inspectAgentCliHooks(inspect, agents.root)
      const config = agents.settings.agentHookInjection()
      const ready = new Set(states.filter((state) => evaluateAgentCliHooks(state, config).ready).map((state) => state.agent.id))
      return AGENTS.map((agent) => ({
        agentId: agent.id,
        displayName: agent.displayName,
        ready: ready.has(agent.id),
        t3Provider: agent.runners.t3?.providerId ?? null,
      }))
    },
  }
}
