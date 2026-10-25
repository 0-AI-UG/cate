// The agents service as the rest of the runtime sees it (architecture 10.3):
// the only owner of agent state. It builds its core (with the terminal
// agents) and the starter, and answers the few calls other modules make;
// hooks and terminal agents stay private to this module.

import os from 'node:os'
import path from 'node:path'
import type { CapabilityImpl } from '@kernel/rpc/runtime'
import type { CateServiceHandlers } from '@kernel/api/contract'
import type {
  AgentChangesSnapshot,
  AgentId,
  agentsCapability,
} from '../contract'
import type { agentApi } from '../contract/api'
import { createAgentApiHandlers, sendToAgent } from './api'
import { agentsCapabilityImpl } from './capability'
import { createAgentsCore, type AgentsCoreDeps } from './core'
import { evaluateAgentCliHooks, inspectAgentCliHooks } from './hooks/readiness'
import { createTerminalAgents, type AgentTerminalService, type TerminalAgents } from './terminal'
import { createAgentStarter, type AgentStartArgs, type AgentStartPorts } from './start'
import { AGENT_SESSION_STORES } from './sessions'
import { createAgentUsage, type AgentUsageDeps } from './usage/usage'

export interface AgentsRuntimeDeps extends AgentsCoreDeps {
  /** The terminal service: the terminal agents plug into its extension points. */
  terminal: AgentTerminalService
  /** What starting an agent needs from panels and worktrees. */
  start: AgentStartPorts
  /** The environment the agent CLIs run with (limit probes). */
  env(): NodeJS.ProcessEnv
  /** Tests: the usage service's rate fetch and clock. */
  usageOptions?: Partial<Pick<AgentUsageDeps, 'fetchRates' | 'now'>>
}

export interface AgentsRuntime {
  /** Starts an agent for `callerPanelId` (undefined for a client). */
  start(callerPanelId: string | undefined, args: AgentStartArgs): Promise<{ panelId: string; agentId: AgentId }>
  /** `cate agent send`'s function: throws when no agent can take it. */
  send(panelId: string, prompt: string): { promptId: string }
  /** Panels whose agent is running a turn. */
  busy(): string[]
  /** Panels an agent is present in, busy or not. */
  hosting(): string[]
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
  const usage = createAgentUsage({
    root: deps.root,
    dataDir: path.join(deps.agentsDir, 'usage'),
    homeDir: deps.homeDir ?? os.homedir(),
    stores: deps.hookOptions?.sessionStores ?? AGENT_SESSION_STORES,
    priceOverrides: () => deps.settings.usagePriceOverrides(),
    env: deps.env,
    log: deps.log,
    ...deps.usageOptions,
  })

  return {
    start: (callerPanelId, args) => starter.start(callerPanelId, args),
    send: (panelId, prompt) => sendToAgent(core, starter, panelId, prompt),
    busy: () => core.busy(),
    hosting: () => core.hosting(),
    changes: (cwd, knownRevision) => core.changes(cwd, knownRevision),
    async readiness(cwd) {
      const states = await inspectAgentCliHooks((dir) => core.hooks.inspectFolders(dir), cwd)
      const config = core.settings.agentHookInjection()
      return states.map((state) => ({ agentId: state.agent.id, ready: evaluateAgentCliHooks(state, config).ready }))
    },
    onSessionEnded: (listener) => terminals.onExit((panelId) => listener(panelId)),
    capability: () => agentsCapabilityImpl(core, starter, usage),
    apiHandlers: () => createAgentApiHandlers(core, starter),
    dispose: () => core.dispose(),
  }
}
