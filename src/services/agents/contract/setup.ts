import type { AgentId } from './registry'

export interface AgentSetupAuthentication {
  status: 'signed-in' | 'signed-out' | 'unknown'
  email?: string
  displayName?: string
  plan?: string
  method?: string
  detail?: string
}
export interface AgentSetupInfo {
  agentId: AgentId
  displayName: string
  downloadUrl: string
  installation: { status: 'missing' | 'installed' | 'unsupported' | 'error'; version?: string; executable?: string; detail?: string }
  authentication: AgentSetupAuthentication
  hooksReady?: boolean
  canLogin: boolean
  canInstall: boolean
}
export interface AgentSetupSnapshot {
  host: { name: string; platform: string; arch: string }
  agents: AgentSetupInfo[]
  operations?: AgentSetupOperation[]
}
export interface AgentSetupOperation {
  id: string
  agentId: AgentId
  action: 'login' | 'install'
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  panelId?: string
  message?: string
  startedAt: string
}

/** Runtime-owned CLI availability; clients only mirror this state. */
export interface AgentAvailability {
  snapshot: AgentSetupSnapshot | null
  types: import('./launch').AgentTypeInfo[]
  refreshing: boolean
  error: string | null
}
