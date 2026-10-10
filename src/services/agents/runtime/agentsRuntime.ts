// The agents service as the rest of the runtime sees it (architecture 10.4):
// the only owner of agent state. It builds its core (with the terminal
// agents) and the starter, and answers the few calls other modules make;
// hooks and terminal agents stay private to this module.

import path from 'node:path'
import type { CapabilityImpl } from '@kernel/rpc/runtime'
import type { CateServiceHandlers } from '@kernel/api/contract'
import type {
  AgentChangesSnapshot,
  AgentId,
  AgentSendResult,
  agentsCapability,
} from '../contract'
import type { agentApi } from '../contract/api'
import { createAgentApiHandlers } from './api'
import { agentsCapabilityImpl } from './capability'
import { createAgentsCore, type AgentsCoreDeps } from './core'
import { evaluateAgentCliHooks, inspectAgentCliHooks } from './hooks/readiness'
import { createTerminalAgents, type AgentTerminalService, type TerminalAgents } from './terminal'
import { createAgentStarter, type AgentStartArgs, type AgentStartPorts } from './start'

export interface AgentsRuntimeDeps extends AgentsCoreDeps {
  /** The terminal service: the terminal agents plug into its extension points. */
  terminal: AgentTerminalService
  /** What starting an agent needs from panels and worktrees. */
  start: AgentStartPorts
}

export interface AgentsRuntime {
  /** Starts an agent for `callerPanelId` (undefined for a client). */
  start(callerPanelId: string | undefined, args: AgentStartArgs): Promise<{ panelId: string; agentId: AgentId }>
  send(panelId: string, prompt: string): Promise<AgentSendResult>
  /** Panels whose agent is running a turn. */
  busy(): string[]
  /** Recorded agent edits in a checkout, each with the panels that showed
   *  its session; an unchanged revision omits records. */
  changes(cwd: string, knownRevision?: string): Promise<AgentChangesSnapshot>
  /** Which agent CLIs can run a hook-backed turn in `cwd`. */
  readiness(cwd: string): Promise<{ agentId: AgentId; ready: boolean }[]>
  /** A panel's agent session ended with its process. */
  onSessionEnded(listener: (panelId: string) => void): () => void
  /** The `agents` capability and the `cate.agent.*` handlers. */
  capability(): CapabilityImpl<typeof agentsCapability>
  apiHandlers(): CateServiceHandlers<typeof agentApi>
  dispose(): void
}

export function createAgentsRuntime(deps: AgentsRuntimeDeps): AgentsRuntime {
  let terminals!: TerminalAgents
  const core = createAgentsCore(deps, (base) =>
    terminals = createTerminalAgents(base, deps.terminal, { stampsFile: path.join(deps.agentsDir, 'stamps.json') }))
  const starter = createAgentStarter(core, deps.start)

  return {
    start: (callerPanelId, args) => starter.start(callerPanelId, args),
    send: (panelId, prompt) => core.send(panelId, prompt),
    busy: () => core.busy(),
    changes: (cwd, knownRevision) => core.changes(cwd, knownRevision),
    async readiness(cwd) {
      const states = await inspectAgentCliHooks((dir) => core.hooks.inspectWorkspace(dir), cwd)
      const config = core.settings.agentHookInjection()
      return states.map((state) => ({ agentId: state.agent.id, ready: evaluateAgentCliHooks(state, config).ready }))
    },
    onSessionEnded: (listener) => terminals.onExit((panelId) => listener(panelId)),
    capability: () => agentsCapabilityImpl(core, starter),
    apiHandlers: () => createAgentApiHandlers(core, starter),
    dispose: () => core.dispose(),
  }
}
