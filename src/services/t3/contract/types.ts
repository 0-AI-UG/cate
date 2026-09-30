import type { T3ProviderId } from './providers'

export type T3HarnessRoute = 'thread' | 'providers' | 'usage'

/** Which checkout's harness a call is about. Omitted means the workspace root;
 *  otherwise the root or one of its worktree checkouts. */
export interface T3CheckoutParams {
  checkout?: string
}

export interface T3PanelParams extends T3CheckoutParams {
  threadId?: string
  route?: T3HarnessRoute
}

/** Where a client loads the harness UI. `url` is on the runtime's machine
 *  (`http://127.0.0.1:<port>`); clients reach it through loopback routing. */
export interface T3PanelTarget {
  url: string
  port: number
  /** Hash of the canonical checkout; stable across harness restarts. */
  instanceId: string
  environmentId: string
  threadId: string | null
  /** T3's browser-session cookie; the client installs it for `url` before
   *  loading the page. */
  session: { name: string; value: string }
}

export type T3HarnessPhase = 'stopped' | 'starting' | 'running' | 'error'

export interface T3HarnessStatus {
  phase: T3HarnessPhase
  message?: string
}

/** Fields of T3's OrchestrationThreadShell Cate tracks (t3@0.0.39): activity,
 *  title, and the provider running the thread. Not provider-process state. */
export interface T3Thread {
  id: string
  title: string
  latestTurn?: { state: string } | null
  /** `providerName` is the T3 provider running the thread. */
  session?: { status: string; activeTurnId: string | null; providerName?: string | null } | null
  hasPendingApprovals?: boolean
  hasPendingUserInput?: boolean
  hasActionableProposedPlan?: boolean
  backgroundLiveness?: 'working' | 'monitoring' | null
}

/** The live thread shells of one harness. Always a full snapshot. */
export interface T3ShellSnapshot {
  instanceId: string
  checkout: string
  connected: boolean
  /** T3's orchestration sequence; a snapshot never replaces a newer one. */
  sequence: number
  threads: Record<string, T3Thread>
}

export type T3ShellEvent =
  | { kind: 'snapshot'; snapshot: T3ShellSnapshot }
  /** A conversation was deleted through the `t3` capability; panels bound to
   *  it close. */
  | { kind: 'deleted'; instanceId: string; threadId: string }

export type T3ThreadActivity = 'notRunning' | 'running' | 'waitingForInput'

export type T3ProviderAuthPhase = 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface T3ProviderAuthParams extends T3CheckoutParams {
  providerId: T3ProviderId
  /** OpenCode wraps multiple model providers, so its CLI needs a provider name. */
  provider?: string
}

export interface T3ProviderAuthSession {
  id: string
  providerId: T3ProviderId
  phase: T3ProviderAuthPhase
  output: string
  url?: string
  code?: string
  message?: string
}

export type T3ProviderConnectionState =
  | 'authenticated'
  | 'unauthenticated'
  | 'unavailable'
  | 'disabled'
  | 'unknown'

export interface T3ProviderStatus {
  providerId: T3ProviderId
  state: T3ProviderConnectionState
  label?: string
  message?: string
  version?: string
  update?: {
    latestVersion: string
    canUpdate: boolean
    message?: string
  }
}

export type T3ProviderSettingsOperation = 'read' | 'save' | 'refresh' | 'update'

export interface T3ProviderSettingsParams extends T3CheckoutParams {
  operation: T3ProviderSettingsOperation
  patch?: Record<string, unknown>
  provider?: string
  instanceId?: string
}

/** T3's own configuration as its settings page edits it. */
export interface T3ProviderSettings {
  settings: unknown
  providers: unknown
}

export interface T3Conversation {
  id: string
  title: string
  updatedAt: string
}

export interface T3ConversationMessage {
  role: 'user' | 'assistant'
  text: string
  createdAt: string
}
