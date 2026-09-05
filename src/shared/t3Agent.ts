export type AgentHarnessRoute = 'thread' | 'providers'

export interface AgentHarnessPanelRequest {
  workspaceId: string
  panelId: string
  /** Cate resource locator for the exact checkout or worktree this panel owns. */
  cwd: string
  threadId?: string
  route?: AgentHarnessRoute
}

export interface AgentHarnessPanelTarget {
  url: string
  partition: string
  runtimeId: string
  environmentId: string
  threadId: string | null
}

export interface AgentHarnessError {
  error: string
}

export type AgentHarnessPhase = 'stopped' | 'starting' | 'running' | 'error'

export interface AgentHarnessStatus {
  phase: AgentHarnessPhase
  message?: string
}

export type AgentProviderId = 'codex' | 'claude' | 'cursor' | 'grok' | 'opencode'

export type AgentProviderAuthPhase = 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface AgentProviderAuthRequest {
  workspaceId: string
  cwd: string
  providerId: AgentProviderId
  /** OpenCode wraps multiple model providers, so its CLI needs a provider name. */
  provider?: string
}

export interface AgentProviderAuthSession {
  id: string
  providerId: AgentProviderId
  phase: AgentProviderAuthPhase
  output: string
  url?: string
  code?: string
  message?: string
}

export interface AgentProviderStatusRequest {
  workspaceId: string
  cwd: string
}

export type AgentProviderConnectionState =
  | 'authenticated'
  | 'unauthenticated'
  | 'unavailable'
  | 'disabled'
  | 'unknown'

export interface AgentProviderStatus {
  providerId: AgentProviderId
  state: AgentProviderConnectionState
  label?: string
  message?: string
  version?: string
  update?: {
    latestVersion: string
    canUpdate: boolean
    message?: string
  }
}
