// services/agents ui: agent logos, per-panel agent status selectors, the
// activity title, the changes pill and the agents settings page.

export { agentLogo } from './logos'
export {
  agentPanelInfo,
  agentInfoByPanel,
  agentPanelTitle,
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
export { AgentActivityTitle, AwaitingIndicator } from './AgentActivityTitle'
export { AgentChangesPill } from './AgentChangesPill'
export { setAgentChangesOpener, type AgentChangesOpener, type AgentChangesRequest } from './changesOpener'
export { AgentHooksSettings } from './AgentHooksSettings'
export { AgentSettings } from './AgentSettings'
