// services/agents ui: agent logos, per-panel agent status selectors, the
// activity title, the changes pill, the relation context transport and the
// agents settings page.

export { agentLogo } from './logos'
export {
  agentPanelInfo,
  agentInfoByPanel,
  agentPanelTitle,
  agentInfoTitle,
  isAgentFallbackTitle,
  type AgentPanelInfo,
} from './panelInfo'
export {
  useAgentPanels,
  useAgentPanelState,
  useAgentPanelInfo,
  useAgentPanelTitle,
  useAgentInfoByPanel,
} from './useAgentPanels'
export { AgentActivityTitle, AwaitingIndicator, RunningIndicator } from './AgentActivityTitle'
export { AgentChangesPill } from './AgentChangesPill'
export { useAgentContextTransport } from './contextTransport'
export { setAgentChangesOpener, type AgentChangesOpener, type AgentChangesRequest } from './changesOpener'
export { AgentHooksSettings } from './AgentHooksSettings'
export { AgentSettings } from './AgentSettings'
