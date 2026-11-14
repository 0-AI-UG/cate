import type { AgentId } from './registry'
import type { GitDiffHunk, GitCommitSummary } from '@workspace/repository/contract'

/** Agent identity owns a change. A panel is only a place that displayed it:
 *  `panelIds` are the panels that showed the agent session, resolved by the
 *  agents service (consumers never see terminals or threads). */
export interface AgentChangeRecord {
  id: string
  agentId: AgentId
  sessionId: string
  turnId: string
  parentSessionId?: string
  panelIds: string[]
  /** Source titles captured with the edit, so closed panels stay identifiable. */
  panelTitles?: Record<string, string>
  /** PR checkout associated with this edit at capture, not current commit membership. */
  prNumber?: number
  cwd: string
  createdAt: string
  files: AgentChangedFile[]
}

export interface AgentChangedFile {
  commit?: GitCommitSummary
  /** True only when the reported edit is represented in the working tree. */
  uncommitted?: boolean
  path: string
  oldPath?: string
  patch?: string
  hunks: GitDiffHunk[]
  additions: number
  deletions: number
  /** Fragments do not claim absolute file line numbers or a complete patch. */
  coverage: 'patch' | 'fragment' | 'unavailable'
}

export interface AgentChangesFilter {
  agentId?: AgentId
  panelId?: string
  sessionId?: string
  turnId?: string
}

/** An unchanged revision omits records so idle polling stays small. */
export interface AgentChangesSnapshot {
  revision: string
  records?: AgentChangeRecord[]
}

export function filterAgentChanges(records: readonly AgentChangeRecord[], filter: AgentChangesFilter): AgentChangeRecord[] {
  return records.filter((r) =>
    (!filter.agentId || r.agentId === filter.agentId)
    && (!filter.panelId || r.panelIds.includes(filter.panelId))
    && (!filter.sessionId || r.sessionId === filter.sessionId || r.parentSessionId === filter.sessionId)
    && (!filter.turnId || r.turnId === filter.turnId),
  )
}
