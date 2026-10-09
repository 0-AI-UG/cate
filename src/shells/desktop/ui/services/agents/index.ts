// services/agents ui: agent logos, per-panel agent status selectors, the
// status marks, the tab decorations and changes overlay, the changes pill, the hooks-off warning, the relation context transport and the
// agents settings page.

export { agentLogo } from './logos'
export {
  agentPanelInfo,
  agentInfoByPanel,
  agentInfoTitle,
  type AgentPanelInfo,
} from './panelInfo'
export {
  useAgentPanels,
  useAgentPanelState,
  useAgentPanelInfo,
  useAgentPanelTitle,
  useAgentInfoByPanel,
} from './useAgentPanels'
export { AwaitingIndicator, RunningIndicator } from './indicators'
export { useAgentTabDecorations, AgentChangesOverlay, AgentHooksOffOverlay } from './tabDecorations'
export { AgentChangesPill } from './AgentChangesPill'
export { agentContextPreview, useAgentContextTransport } from './contextTransport'
export { setAgentChangesOpener, type AgentChangesOpener, type AgentChangesRequest } from './changesOpener'
export { AgentHooksSettings } from './AgentHooksSettings'
export { AgentSettings } from './AgentSettings'
