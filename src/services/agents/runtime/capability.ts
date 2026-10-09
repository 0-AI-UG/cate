import type { CapabilityImpl } from '@kernel/rpc/runtime'
import { applyAgentPanelStatesChange, type agentsCapability } from '../contract'
import type { AgentsRuntime } from './agentsRuntime'
import { interruptAgent, sendToAgent, startAgent } from './api'
import type { AgentStarter } from './start'

export function agentsCapabilityImpl(agents: AgentsRuntime, starter: AgentStarter): CapabilityImpl<typeof agentsCapability> {
  return {
    start: (request) => startAgent(starter, undefined, request),
    types: () => starter.types(),
    send: ({ panelId, prompt }) => sendToAgent(agents, panelId, prompt),
    interrupt: ({ panelId }) => interruptAgent(agents, panelId),
    inspectHooks: ({ cwd }) => agents.inspectHooks(cwd),
    async readChanges({ cwd, knownRevision }) {
      return agents.hooks.readChanges(await agents.resolveCheckout(cwd), knownRevision)
    },
    async bindChanges({ cwd, threadId, panelId }) {
      await agents.hooks.bindChanges(await agents.resolveCheckout(cwd), threadId, panelId)
    },
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
    notifications(_params, sink) {
      return agents.notifications.subscribe((event) => sink.emit(event))
    },
  }
}
