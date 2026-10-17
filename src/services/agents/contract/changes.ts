import type { AgentId } from './registry'
import type { GitDiffHunk } from '@workspace/repository/contract'

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
  cwd: string
  createdAt: string
  files: AgentChangedFile[]
}

export interface AgentChangedFile {
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

/** What the helpers below read of a record, stored or resolved. */
type ChangeLike = Pick<AgentChangeRecord, 'agentId' | 'sessionId' | 'turnId' | 'parentSessionId' | 'createdAt' | 'files'>

export function filterAgentChanges(records: readonly AgentChangeRecord[], filter: AgentChangesFilter): AgentChangeRecord[] {
  return records.filter((r) =>
    (!filter.agentId || r.agentId === filter.agentId)
    && (!filter.panelId || r.panelIds.includes(filter.panelId))
    && (!filter.sessionId || r.sessionId === filter.sessionId || r.parentSessionId === filter.sessionId)
    && (!filter.turnId || r.turnId === filter.turnId),
  )
}

function comparablePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** Recorded edits still represented by a staged or unstaged file in the
 *  checkout. The durable records remain available as history. */
export function activeAgentChanges<R extends ChangeLike>(
  records: readonly R[],
  git: { isRepo: boolean; statusFiles: readonly { path: string }[] },
): R[] {
  if (!git.isRepo) return [...records]
  const changed = new Set(git.statusFiles.map((file) => comparablePath(file.path)))
  return records.flatMap((record) => {
    const files = record.files.filter((file) => changed.has(comparablePath(file.path))
      || (file.oldPath ? changed.has(comparablePath(file.oldPath)) : false))
    return files.length ? [{ ...record, files }] : []
  })
}
