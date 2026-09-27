import type { AgentId } from './agents'

export type AgentApprovalMode = 'automatic' | 'manual' | 'unknown'

export interface AgentApprovalDetection {
  source: 'config' | 'signal' | 'unavailable'
  mode: AgentApprovalMode
  detail: string
}

export const AGENT_APPROVAL_DETECTION: Record<AgentId, AgentApprovalDetection> = {
  codex: { source: 'config', mode: 'unknown', detail: 'Configuration has not been read.' },
  'claude-code': { source: 'signal', mode: 'unknown', detail: 'Uses the CLI’s human permission-prompt notification.' },
  hermes: { source: 'signal', mode: 'unknown', detail: 'Uses the request’s review surface: automatic review or human prompt.' },
  grok: { source: 'signal', mode: 'unknown', detail: 'Uses the CLI’s human permission-prompt notification.' },
  opencode: { source: 'signal', mode: 'unknown', detail: 'Uses the CLI’s permission request and response events.' },
  cursor: { source: 'unavailable', mode: 'unknown', detail: 'This CLI does not report permission waits. Turns stay Running until completion.' },
  kiro: { source: 'unavailable', mode: 'unknown', detail: 'This CLI does not report permission waits. Turns stay Running until completion.' },
}
