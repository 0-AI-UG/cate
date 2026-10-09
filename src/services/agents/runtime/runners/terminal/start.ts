// Starting an agent CLI in a terminal panel: the hook-ready agent for the
// checkout, run in place of the panel's shell (a new panel, or an idle one
// the caller names).

import { RpcError } from '@kernel/rpc/contract'
import { AGENT_LAUNCH, type AgentId } from '../../../contract'
import type { AgentsCore } from '../../core'
import { resolveDriverAgent } from '../../hooks/readiness'
import type { AgentStartPorts, RunnerStart } from '../../start'

const fail = (code: string): never => { throw new RpcError('rejected', code) }

export function createTerminalStart(agents: AgentsCore, terminals: AgentStartPorts['terminals']): RunnerStart<AgentId> {
  return {
    check(args, callerPanelId) {
      const panelId = args.terminalPanelId
      if (!panelId) return
      if (panelId === callerPanelId) fail('agent-cannot-replace-caller-terminal')
      const terminal = terminals.state(panelId)
      if (!terminal) fail('terminal-not-found')
      if (terminal!.alive && (agents.registry.sessionFor(panelId)?.present || terminal!.busy)) fail('terminal-busy')
    },
    // The hook-ready agent (strict for a preference).
    async choose(args, cwd) {
      try {
        const agent = await resolveDriverAgent((dir) => agents.hooks.inspectWorkspace(dir), cwd, args.agentId ?? '', {
          fallbackCwd: agents.root,
          hookConfig: agents.settings.agentHookInjection(),
        })
        return agent.id
      } catch (error) {
        return fail(error instanceof Error ? `agent-hooks-not-ready: ${error.message}` : 'agent-hooks-not-ready')
      }
    },
    async launch(agentId, { args, prompt, checkout, placement }) {
      const launch = { kind: AGENT_LAUNCH.start, params: { agentId, prompt } }
      if (args.terminalPanelId) {
        // Reuse the panel, not its shell process: restarting the PTY
        // launches the canonical executable and argv directly.
        await terminals.relaunch(args.terminalPanelId, { ...checkout, launch })
        return { panelId: args.terminalPanelId, agentId }
      }
      const title = args.title?.trim() || prompt.replace(/\s+/g, ' ').slice(0, 54)
      return { panelId: await terminals.create({ ...checkout, title, launch, placement }), agentId }
    },
  }
}
