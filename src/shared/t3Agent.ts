export type AgentHarnessRoute = 'thread' | 'providers' | 'usage'

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

/** Fields of T3's OrchestrationThreadShell Cate tracks (t3@0.0.39): activity,
 *  title, and the provider running the thread. Not provider-process state. */
export interface T3Thread {
  id: string
  title: string
  latestTurn?: { state: string } | null
  /** `providerName` is the T3 provider running the thread (see agentIdForT3Provider). */
  session?: { status: string; activeTurnId: string | null; providerName?: string | null } | null
  hasPendingApprovals?: boolean
  hasPendingUserInput?: boolean
  hasActionableProposedPlan?: boolean
  backgroundLiveness?: 'working' | 'monitoring' | null
}

/** The live thread shells of one T3 harness (keyed by its session partition),
 *  pushed by main's shell subscription. Always a full snapshot. */
export interface T3ShellSnapshot {
  partition: string
  connected: boolean
  /** T3's orchestration sequence; a snapshot never replaces a newer one. */
  sequence: number
  threads: Record<string, T3Thread>
}

export type T3RemoteOperation = 'status' | 'link' | 'unlink'

export interface T3RemoteSession {
  id: string
  operation: T3RemoteOperation
  phase: 'running' | 'succeeded' | 'failed' | 'cancelled'
  output: string
  authorizationUrl?: string
  message?: string
}

export type AgentProviderId = import('./agents').T3ProviderId

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

export interface T3Conversation {
  id: string
  title: string
  updatedAt: string
}
