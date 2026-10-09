// The agents service as the rest of the runtime sees it (architecture 10.4):
// the only owner of agent state. It builds its core, both runners and the
// starter, and answers the few calls other modules make; runners, hooks and
// the registry stay private to this module.

import path from 'node:path'
import type { CapabilityImpl } from '@kernel/rpc/runtime'
import type { CateServiceHandlers } from '@kernel/api/contract'
import type {
  AgentChangesSnapshot,
  AgentId,
  AgentRunner,
  AgentSendResult,
  AgentSessionChanges,
  agentsCapability,
} from '../contract'
import type { agentApi } from '../contract/api'
import { createAgentApiHandlers } from './api'
import { agentsCapabilityImpl } from './capability'
import { createAgentsCore, type AgentsCoreDeps } from './core'
import { evaluateAgentCliHooks, inspectAgentCliHooks } from './hooks/readiness'
import { createT3Runner, type RunnerT3Service, type T3PanelBindings } from './runners/t3'
import { createTerminalRunner, type RunnerTerminalService } from './runners/terminal'
import { createAgentStarter, type AgentStartArgs, type AgentStartPorts } from './start'

export interface AgentsRuntimeDeps extends AgentsCoreDeps {
  /** The terminal service: the terminal runner plugs into its extension points. */
  terminal: RunnerTerminalService
  /** The t3 service the t3 runner follows. */
  t3: RunnerT3Service
  /** Which thread each chat panel shows (the chat panel type's view of the
   *  document). */
  chatThreads: T3PanelBindings
  /** What starting an agent needs from panels, worktrees and T3. */
  start: AgentStartPorts
}

export interface AgentsRuntime {
  /** Starts an agent for `callerPanelId` (undefined for a client). */
  start(callerPanelId: string | undefined, args: AgentStartArgs): Promise<{ panelId: string; runner: AgentRunner; agentId: AgentId | null }>
  send(panelId: string, prompt: string): Promise<AgentSendResult>
  /** Panels whose agent is running a turn. */
  busy(): string[]
  /** Recorded agent edits in a checkout, each with the panels that showed
   *  its session; an unchanged revision omits records. */
  changes(cwd: string, knownRevision?: string): Promise<AgentChangesSnapshot>
  /** Per-turn summaries of the panel's current session's edits still changed
   *  in its checkout: now, then whenever they may have changed. */
  watchChanges(panelId: string, listener: (changes: AgentSessionChanges | null) => void): () => void
  /** Which agent CLIs can run a hook-backed turn in `cwd`. */
  readiness(cwd: string): Promise<{ agentId: AgentId; ready: boolean }[]>
  /** A panel's agent session ended with its process. */
  onSessionEnded(listener: (panelId: string) => void): () => void
  /** The relation context to send with the panel's next prompt (armed
   *  context is disarmed); a T3 page asks before it sends. */
  relationContext(panelId: string, agentId: AgentId | null): Promise<string | null>
  /** Env for a starting T3 harness so it reports its edits. */
  changeCaptureEnv(harness: { id: string; checkout: string }): Promise<Record<string, string>>
  /** A T3 harness stopped. */
  releaseChangeCapture(id: string): void
  /** The `agents` capability and the `cate.agent.*` handlers. */
  capability(): CapabilityImpl<typeof agentsCapability>
  apiHandlers(): CateServiceHandlers<typeof agentApi>
  dispose(): void
}

export function createAgentsRuntime(deps: AgentsRuntimeDeps): AgentsRuntime {
  const core = createAgentsCore(deps)
  const terminalRunner = createTerminalRunner(core, deps.terminal, { stampsFile: path.join(deps.agentsDir, 'stamps.json') })
  const t3Runner = createT3Runner(core, deps.t3, deps.chatThreads)
  const offs = [core.registry.register(terminalRunner), core.registry.register(t3Runner)]
  const starter = createAgentStarter(core, deps.start)

  return {
    start: (callerPanelId, args) => starter.start(callerPanelId, args),
    send: (panelId, prompt) => core.send(panelId, prompt),
    busy: () => core.busy(),
    changes: (cwd, knownRevision) => core.changes(cwd, knownRevision),
    watchChanges: (panelId, listener) => core.watchChanges(panelId, listener),
    async readiness(cwd) {
      const states = await inspectAgentCliHooks((dir) => core.hooks.inspectWorkspace(dir), cwd)
      const config = core.settings.agentHookInjection()
      return states.map((state) => ({ agentId: state.agent.id, ready: evaluateAgentCliHooks(state, config).ready }))
    },
    onSessionEnded: (listener) => terminalRunner.onExit((panelId) => listener(panelId)),
    relationContext: (panelId, agentId) => core.promptContext.prepareForSend(panelId, agentId),
    changeCaptureEnv: (harness) => t3Runner.changeCaptureEnv(harness),
    releaseChangeCapture: (id) => t3Runner.releaseChangeCapture(id),
    capability: () => agentsCapabilityImpl(core, starter),
    apiHandlers: () => createAgentApiHandlers(core, starter),
    dispose() {
      for (const off of offs.splice(0)) off()
      t3Runner.dispose()
      terminalRunner.dispose()
      core.dispose()
    },
  }
}
