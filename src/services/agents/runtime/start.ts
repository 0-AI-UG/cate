// Starting an agent (`cate.agent.start`): in the caller's checkout or a
// worktree, next to the caller unless told where; each runner launches its
// own kind (runners/*/start.ts). Once started it is an agent like any other:
// `cate.agent.*` talks to it by its panel. Panels, worktrees and T3 come
// through injected ports, since they live in other modules.

import { RpcError } from '@kernel/rpc/contract'
import type { Point } from '@workspace/canvas/contract'
import type { PlaceTarget } from '@workspace/document/contract'
import type { T3ProviderModels, T3StartThreadParams } from '@services/t3/contract'
import { AGENTS, isAgentId, type AgentId, type AgentRunner, type AgentTypeInfo } from '../contract'
import type { AgentsCore } from './core'
import { evaluateAgentCliHooks, inspectAgentCliHooks } from './hooks/readiness'
import { createT3Start } from './runners/t3/start'
import { createTerminalStart } from './runners/terminal/start'

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
    /** Ends a thread a failed start left without a chat. */
    stopThread(params: { checkout?: string; threadId: string }): Promise<void>
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

/** How one runner starts an agent: checks the request, picks what runs
 *  (before any worktree exists, so a refused start leaves none), then
 *  launches it in the checkout. */
export interface RunnerStart<Choice> {
  check(args: StartRequest, callerPanelId: string | undefined): void
  choose(args: StartRequest, cwd: string): Promise<Choice>
  launch(choice: Choice, context: {
    args: StartRequest
    prompt: string
    checkout: { cwd: string; worktreeId?: string }
    placement: AgentPlacement
  }): Promise<{ panelId: string; agentId: AgentId | null }>
}

/** Start arguments once validated. */
export type StartRequest = Omit<AgentStartArgs, 'agentId'> & { agentId?: AgentId }

export function createAgentStarter(agents: AgentsCore, ports: AgentStartPorts): AgentStarter {
  const runners: { [R in AgentRunner]: RunnerStart<unknown> } = {
    terminal: createTerminalStart(agents, ports.terminals) as RunnerStart<unknown>,
    t3: createT3Start(agents, ports) as RunnerStart<unknown>,
  }

  /** The checkout to run in: the asked worktree, else the caller's own. */
  const checkoutFor = (callerPanelId: string | undefined, worktreeId: string | undefined): { cwd: string; worktreeId?: string } => {
    if (worktreeId) {
      const cwd = agents.document.worktreePath(worktreeId)
      if (!cwd) fail('worktree-not-registered')
      return { cwd: cwd!, worktreeId }
    }
    const inherited = callerPanelId ? agents.document.panel(callerPanelId)?.worktreeId : undefined
    const cwd = inherited ? agents.document.worktreePath(inherited) : undefined
    return inherited && cwd && cwd !== agents.root ? { cwd, worktreeId: inherited } : { cwd: agents.root }
  }

  return {
    async start(callerPanelId, input) {
      agents.trust.requireTrusted()
      const prompt = input.prompt.trim()
      if (!prompt) fail('prompt-required')
      if (prompt.includes('\0')) fail('invalid-prompt')
      if (input.agentId !== undefined && !isAgentId(input.agentId)) fail('unsupported-agent')
      if (input.worktreeId && input.newWorktree) fail('choose-worktreeId-or-newWorktree')
      const args = input as StartRequest
      const runner = args.runner ?? 'terminal'
      const start = runners[runner]
      start.check(args, callerPanelId)
      const placement = args.placement ?? (callerPanelId ? { near: callerPanelId } : {})

      const existing = args.newWorktree ? null : checkoutFor(callerPanelId, args.worktreeId)
      const choice = await start.choose(args, existing?.cwd ?? agents.root)

      const created = args.newWorktree ? await ports.worktrees.create(args.newWorktree) : null
      const checkout = created ? { cwd: created.path, worktreeId: created.id } : existing!
      try {
        const { panelId, agentId } = await start.launch(choice, { args, prompt, checkout, placement })
        return { panelId, runner, agentId }
      } catch (error) {
        if (created) await ports.worktrees.remove(created.id).catch(() => {})
        throw error
      }
    },

    async types() {
      agents.trust.requireTrusted()
      const states = await inspectAgentCliHooks((dir) => agents.hooks.inspectWorkspace(dir), agents.root)
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
