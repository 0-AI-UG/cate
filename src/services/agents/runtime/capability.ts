import type { CapabilityImpl } from '@kernel/rpc/runtime'
import { applyAgentPanelStatesChange, type agentsCapability } from '../contract'
import type { AgentsCore } from './core'
import { interruptAgent, sendToAgent, startAgent, withdrawFromAgent } from './api'
import type { AgentStarter } from './start'
import type { AgentUsageService } from './usage/usage'

export function agentsCapabilityImpl(agents: AgentsCore, starter: AgentStarter, usage: AgentUsageService): CapabilityImpl<typeof agentsCapability> {
  return {
    usage: (input) => usage.summary(input),
    refreshUsageRates: () => usage.refreshRates(),
    usageLimits: (args) => usage.limits(args?.refresh === true),
    start: (request) => startAgent(starter, undefined, request),
    types: () => starter.types(),
    send: ({ panelId, prompt, attachments }) => sendToAgent(agents, starter, panelId, prompt, attachments),
    withdraw: ({ panelId, promptId }) => withdrawFromAgent(agents, starter, panelId, promptId),
    interrupt: ({ panelId }) => interruptAgent(agents, panelId),
    inspectHooks: ({ cwd }) => agents.inspectHooks(cwd),
    panel: ({ panelId }) => agents.panel(panelId),
    previewContext: ({ panelId }) => agents.promptContext.peek(panelId, agents.panel(panelId)?.agentId ?? null),
    busy: () => ({ panelIds: agents.busy() }),
    panels(_params, sink) {
      let rev = 0
      let states = agents.panels.all()
      sink.emit({ kind: 'snapshot', rev, snapshot: states })
      return agents.panels.subscribe((change) => {
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
