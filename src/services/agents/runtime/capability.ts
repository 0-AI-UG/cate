import type { CapabilityImpl } from '@kernel/rpc/runtime'
import { applyAgentPanelStatesChange, type agentsCapability } from '../contract'
import type { AgentsCore } from './core'
import { interruptAgent, sendToAgent, startAgent } from './api'
import type { AgentStarter } from './start'

export function agentsCapabilityImpl(agents: AgentsCore, starter: AgentStarter): CapabilityImpl<typeof agentsCapability> {
  return {
    start: (request) => startAgent(starter, undefined, request),
    types: () => starter.types(),
    send: ({ panelId, prompt }) => sendToAgent(agents, panelId, prompt),
    interrupt: ({ panelId }) => interruptAgent(agents, panelId),
    inspectHooks: ({ cwd }) => agents.inspectHooks(cwd),
    panel: ({ panelId }) => agents.panel(panelId),
    busy: () => ({ panelIds: agents.busy() }),
    panels(_params, sink) {
      let rev = 0
      let states = agents.registry.all()
      sink.emit({ kind: 'snapshot', rev, snapshot: states })
      return agents.registry.subscribe((change) => {
        states = applyAgentPanelStatesChange(states, change)
        sink.emit({ kind: 'change', rev: ++rev, change })
      })
    },
    conversation({ panelId }, sink) {
      let rev = 0
      return agents.conversations.watch(panelId, (conversation, change) => {
        if (change) sink.emit({ kind: 'change', rev: ++rev, change })
        else sink.emit({ kind: 'snapshot', rev: rev = 0, snapshot: conversation })
      })
    },
  }
}
