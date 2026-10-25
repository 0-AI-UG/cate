// Starting an agent (`cate.agent.start`): the hook-ready agent CLI for the
// checkout, run in place of a terminal panel's shell (a new panel, or an idle
// one the caller names), in the caller's checkout or a worktree, next to the
// caller unless told where. Once started it is an agent like any other:
// `cate.agent.*` talks to it by its panel. Panels and worktrees come
// through injected ports, since they live in other modules.

import { RpcError } from '@kernel/rpc/contract'
import type { Point } from '@workspace/canvas/contract'
import type { PlaceTarget } from '@workspace/document/contract'
import { AGENT_DEFS, AGENT_LAUNCH, AGENTS, isAgentId, isPromptAttachments, type AgentId, type AgentTypeInfo } from '../contract'
import type { AgentsCore } from './core'
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
    /** A new terminal panel running `launch`; resolves once its PTY started.
     *  `titleChosen`: the caller named it, so the agent never retitles it. */
    create(params: { cwd: string; worktreeId?: string; title: string; titleChosen?: boolean; launch: AgentTerminalLaunch; placement: AgentPlacement }): Promise<string>
    /** Restarts an existing terminal panel's PTY with `launch`. */
    relaunch(panelId: string, params: { cwd: string; worktreeId?: string; launch: AgentTerminalLaunch }): Promise<void>
    /** A terminal panel's PTY, or null for a panel that is no terminal. */
    state(panelId: string): { alive: boolean; busy: boolean } | null
  }
  worktrees: {
    create(name: string): Promise<{ id: string; path: string }>
    /** Removes a worktree this start created, when the start failed. */
    remove(worktreeId: string): Promise<void>
  }
}

export interface AgentStartArgs {
  /** Absent: the agent's interactive session, waiting for its first prompt. */
  prompt?: string
  /** Files that go with the prompt (then the prompt may be empty). */
  attachments?: string[]
  agentId?: string
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
  start(callerPanelId: string | undefined, args: AgentStartArgs): Promise<{ panelId: string; agentId: AgentId }>
  /** Every agent CLI, in registry order. */
  types(): Promise<AgentTypeInfo[]>
  /** Started agents whose CLI has not been observed yet: until its first
   *  hook, a started panel is no agent panel to the terminal agents. */
  starting(): Array<{ panelId: string; agentId: AgentId }>
}

/** How long a started agent counts as starting before its CLI is observed. */
const START_GRACE_MS = 60_000

function fail(code: string): never {
  throw new RpcError('rejected', code)
}

/** Start arguments once validated. */
type StartRequest = Omit<AgentStartArgs, 'agentId'> & { agentId?: AgentId }

export function createAgentStarter(agents: AgentsCore, ports: AgentStartPorts): AgentStarter {
  const pending = new Map<string, { agentId: AgentId; at: number }>()
  /** Still starting: recent, its terminal running, its agent not observed. */
  const stillStarting = (panelId: string, at: number): boolean =>
    Date.now() - at < START_GRACE_MS
    && ports.terminals.state(panelId)?.alive === true
    && (agents.panels.state(panelId)?.status ?? 'notRunning') === 'notRunning'

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

  /** Refuses reusing a terminal that is the caller's own or is busy. */
  const checkTerminal = (panelId: string, callerPanelId: string | undefined): void => {
    if (panelId === callerPanelId) fail('agent-cannot-replace-caller-terminal')
    const terminal = ports.terminals.state(panelId)
    if (!terminal) fail('terminal-not-found')
    if (terminal!.alive && (agents.panels.state(panelId)?.present || terminal!.busy)) fail('terminal-busy')
  }

  /** The hook-ready agent for the checkout (strict for a preference). */
  const chooseAgent = async (agentId: AgentId | undefined, cwd: string): Promise<AgentId> => {
    try {
      const agent = await resolveDriverAgent((dir) => agents.hooks.inspectFolders(dir), cwd, agentId ?? '', {
        fallbackCwd: agents.root,
        hookConfig: agents.settings.agentHookInjection(),
      })
      return agent.id
    } catch (error) {
      return fail(error instanceof Error ? `agent-hooks-not-ready: ${error.message}` : 'agent-hooks-not-ready')
    }
  }

  return {
    async start(callerPanelId, input) {
      agents.trust.requireTrusted()
      const attachments = input.attachments?.length ? input.attachments : undefined
      if (attachments && !isPromptAttachments(attachments)) fail('invalid-attachments')
      const prompt = input.prompt?.trim() ?? (attachments ? '' : undefined)
      if (prompt === '' && !attachments) fail('prompt-required')
      if (prompt?.includes('\0')) fail('invalid-prompt')
      if (input.agentId !== undefined && !isAgentId(input.agentId)) fail('unsupported-agent')
      if (input.worktreeId && input.newWorktree) fail('choose-worktreeId-or-newWorktree')
      const args = input as StartRequest
      if (args.terminalPanelId) checkTerminal(args.terminalPanelId, callerPanelId)
      const placement = args.placement ?? (callerPanelId ? { near: callerPanelId } : {})

      // The agent is picked before any worktree exists, so a refused start
      // leaves none.
      const existing = args.newWorktree ? null : checkoutFor(callerPanelId, args.worktreeId)
      const agentId = await chooseAgent(args.agentId, existing?.cwd ?? agents.root)

      const created = args.newWorktree ? await ports.worktrees.create(args.newWorktree) : null
      const checkout = created ? { cwd: created.path, worktreeId: created.id } : existing!
      const launch = { kind: AGENT_LAUNCH.start, params: { agentId, ...(prompt !== undefined ? { prompt } : {}), ...(attachments ? { attachments } : {}) } }
      try {
        if (args.terminalPanelId) {
          // Reuse the panel, not its shell process: restarting the PTY
          // launches the canonical executable and argv directly.
          await ports.terminals.relaunch(args.terminalPanelId, { ...checkout, launch })
          pending.set(args.terminalPanelId, { agentId, at: Date.now() })
          return { panelId: args.terminalPanelId, agentId }
        }
        const chosen = args.title?.trim()
        const title = chosen || (prompt ? prompt.replace(/\s+/g, ' ').slice(0, 54) : AGENT_DEFS[agentId].displayName)
        const panelId = await ports.terminals.create({ ...checkout, title, ...(chosen ? { titleChosen: true } : {}), launch, placement })
        pending.set(panelId, { agentId, at: Date.now() })
        return { panelId, agentId }
      } catch (error) {
        if (created) await ports.worktrees.remove(created.id).catch(() => {})
        throw error
      }
    },

    async types() {
      agents.trust.requireTrusted()
      const states = await inspectAgentCliHooks((dir) => agents.hooks.inspectFolders(dir), agents.root)
      const config = agents.settings.agentHookInjection()
      const ready = new Set(states.filter((state) => evaluateAgentCliHooks(state, config).ready).map((state) => state.agent.id))
      return AGENTS.map((agent) => ({
        agentId: agent.id,
        displayName: agent.displayName,
        ready: ready.has(agent.id),
      }))
    },

    starting() {
      const out: Array<{ panelId: string; agentId: AgentId }> = []
      for (const [panelId, { agentId, at }] of pending) {
        if (stillStarting(panelId, at)) out.push({ panelId, agentId })
        else pending.delete(panelId)
      }
      return out
    },
  }
}
