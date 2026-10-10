// The agents service's runtime side: one entry, `createAgentsRuntime`, and
// the port types other modules fill. Terminal agents and hooks are
// private to the module.

export { createAgentsRuntime, type AgentsRuntime, type AgentsRuntimeDeps } from './agentsRuntime'
export type { AgentsSettingsReader, TrustGate } from './core'
export type { AgentsDocument } from './promptContext'
export type { AgentPlacement, AgentStartArgs, AgentStartPorts, AgentTerminalLaunch } from './start'
export type { AgentTerminalService } from './terminal'
export { withoutInheritedHookIdentity } from './hooks/agentHooks'
