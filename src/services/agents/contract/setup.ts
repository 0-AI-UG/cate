import type { AgentId } from './registry'

export type AgentConnection = 'native' | 'api'
export type AgentApiProtocol = 'messages' | 'responses' | 'chat-completions'
export interface AgentProviderModel {
  id: string
  name?: string
  maxInputTokens?: number
  maxOutputTokens?: number
}
export interface AgentProvider {
  name: string
  baseUrl: string
  api: AgentApiProtocol
  models: AgentProviderModel[]
}
export interface AgentProviderSaveRequest extends AgentProvider {
  id?: string
  /** Omit to retain an existing key. Never returned to clients. */
  apiKey?: string
}
export interface AgentProviderInfo extends AgentProvider { id: string; hasKey: boolean }
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
  api: { protocol: AgentApiProtocol | null; reason?: string; configured: boolean }
  connection: AgentConnection
  providerId?: string
  model?: string
  hooksReady?: boolean
  canLogin: boolean
  canInstall: boolean
}
export interface AgentSetupSnapshot {
  host: { name: string; platform: string; arch: string }
  agents: AgentSetupInfo[]
  providers: AgentProviderInfo[]
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
/** Select a connection without modifying native login files. */
export interface AgentSetupConfigureRequest {
  agentId: AgentId
  connection: AgentConnection
  providerId?: string
  model?: string
}

/** Runtime-owned CLI availability; clients only mirror this state. */
export interface AgentAvailability {
  snapshot: AgentSetupSnapshot | null
  types: import('./launch').AgentTypeInfo[]
  refreshing: boolean
  error: string | null
}
