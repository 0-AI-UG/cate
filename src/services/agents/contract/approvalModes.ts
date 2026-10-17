// How each agent CLI's permission requests are told apart: a confirmed human
// prompt (permission-wait) versus a check an automatic reviewer or another
// hook may resolve (permission-check). See docs/agent-activity.md. Pure.

import type { AgentId } from './registry'

export type AgentApprovalMode = 'automatic' | 'manual' | 'unknown'

export interface AgentApprovalDetection {
  /** 'config': read from the CLI's resolved configuration (Codex).
   *  'signal': the CLI's hooks confirm a human prompt themselves.
   *  'unavailable': the CLI's hooks cannot tell. */
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
