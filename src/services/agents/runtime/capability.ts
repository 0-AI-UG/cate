import { RpcError } from '@kernel/rpc/contract'
import type { AgentSetupService } from './setup/service'
import type { CapabilityImpl } from '@kernel/rpc/runtime'
import { applyAgentPanelStatesChange, type agentsCapability } from '../contract'
import type { AgentsCore } from './core'
import { interruptAgent, sendToAgent, startAgent, withdrawFromAgent } from './api'
import type { AgentStarter } from './start'
import type { AgentUsageService } from './usage/usage'

export function agentsCapabilityImpl(agents: AgentsCore, starter: AgentStarter, usage: AgentUsageService, setup?: AgentSetupService): CapabilityImpl<typeof agentsCapability> {
  const unavailable = (): never => { throw new RpcError('rejected', 'Agent setup is unavailable.') }
  return {
    setupInspect: ({ refresh }) => setup ? setup.inspect(refresh) : unavailable(),
    setupBegin: (args) => setup ? setup.begin(args) : unavailable(),
    setupOperation: ({ operationId }) => setup ? setup.operation(operationId) : unavailable(),
    setupCancel: ({ operationId }) => setup ? setup.cancel(operationId) : unavailable(),
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
    availability(_params, sink) {
      if (!setup) return unavailable()
      let rev = 0
      return setup.watch((state) => {
        if (rev === 0) sink.emit({ kind: 'snapshot', rev: rev++, snapshot: state })
        else sink.emit({ kind: 'change', rev: rev++, change: state })
      })
    },
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
