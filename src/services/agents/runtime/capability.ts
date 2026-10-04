import type { CapabilityImpl } from '@kernel/rpc/runtime'
import { applyAgentPanelStatesChange, type agentsCapability } from '../contract'
import type { AgentsRuntime } from './agentsRuntime'
import type { Missions } from './missions/missions'

export function agentsCapabilityImpl(agents: AgentsRuntime, missions?: Missions): CapabilityImpl<typeof agentsCapability> {
  return {
    inspectHooks: ({ cwd }) => agents.inspectHooks(cwd),
    async readChanges({ cwd, knownRevision }) {
      return agents.hooks.readChanges(await agents.resolveCheckout(cwd), knownRevision)
    },
    async bindChanges({ cwd, threadId, panelId }) {
      await agents.hooks.bindChanges(await agents.resolveCheckout(cwd), threadId, panelId)
    },
    panel: ({ panelId }) => agents.panel(panelId),
    busy: () => ({ panelIds: agents.busy() }),
    stopMission: ({ ownerPanelId }) => missions?.stopAll(ownerPanelId) ?? { stopped: 0 },
    panels(_params, sink) {
      let rev = 0
      let states = agents.registry.all()
      sink.emit({ kind: 'snapshot', rev, snapshot: states })
      return agents.registry.subscribe((change) => {
        states = applyAgentPanelStatesChange(states, change)
        sink.emit({ kind: 'change', rev: ++rev, change })
      })
    },
    notifications(_params, sink) {
      return agents.notifications.subscribe((event) => sink.emit(event))
    },
  }
}
