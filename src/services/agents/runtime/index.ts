// The agents service's runtime side: one entry, `createAgentsRuntime`, and
// the port types other modules fill. Runners, hooks and the registry are
// private to the module.

export { createAgentsRuntime, type AgentsRuntime, type AgentsRuntimeDeps } from './agentsRuntime'
export type { AgentsSettingsReader, TrustGate } from './core'
export type { AgentsDocument } from './promptContext'
export type { AgentPlacement, AgentStartArgs, AgentStartPorts, AgentTerminalLaunch } from './start'
export type { RunnerTerminalService } from './runners/terminal'
export type { RunnerT3Service, T3PanelBindings } from './runners/t3'
export { withoutInheritedHookIdentity } from './hooks/agentHooks'
