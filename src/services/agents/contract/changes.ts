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
  /** Provider turn snapshots supersede tool edits for that session/turn. */
  mode: 'operation' | 'snapshot'
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
type ChangeLike = Pick<AgentChangeRecord, 'agentId' | 'sessionId' | 'turnId' | 'parentSessionId' | 'createdAt' | 'mode' | 'files'>

/** Per-turn summaries of the changes of one agent session. */
export type AgentSessionChanges = { sessionId: string; turns: Record<string, AgentChangeSummary[]> }
export type AgentChangeSummary = { path: string; kind: 'modified'; additions: number; deletions: number }

export function effectiveAgentChanges<R extends ChangeLike>(records: readonly R[]): R[] {
  const snapshots = new Map<string, R>()
  const key = (r: R) => JSON.stringify([r.agentId, r.sessionId, r.turnId])
  for (const record of records) {
    if (record.mode !== 'snapshot') continue
    const previous = snapshots.get(key(record))
    if (!previous || previous.createdAt <= record.createdAt) snapshots.set(key(record), record)
  }
  return records.filter((r) => !snapshots.has(key(r)) || snapshots.get(key(r)) === r)
}

export function filterAgentChanges(records: readonly AgentChangeRecord[], filter: AgentChangesFilter): AgentChangeRecord[] {
  return effectiveAgentChanges(records).filter((r) =>
    (!filter.agentId || r.agentId === filter.agentId)
    && (!filter.panelId || r.panelIds.includes(filter.panelId))
    && (!filter.sessionId || r.sessionId === filter.sessionId || r.parentSessionId === filter.sessionId)
    && (!filter.turnId || r.turnId === filter.turnId),
  )
}

/** Counts describe recorded edits, not the current checkout's net Git diff. */
export function summarizeAgentChanges(records: readonly ChangeLike[]): AgentChangeSummary[] {
  const files = new Map<string, AgentChangeSummary>()
  for (const record of effectiveAgentChanges(records)) for (const file of record.files) {
    const previous = files.get(file.path) ?? { path: file.path, kind: 'modified' as const, additions: 0, deletions: 0 }
    files.set(file.path, { ...previous, additions: previous.additions + file.additions, deletions: previous.deletions + file.deletions })
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path))
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
  const effective = effectiveAgentChanges(records)
  if (!git.isRepo) return effective
  const changed = new Set(git.statusFiles.map((file) => comparablePath(file.path)))
  return effective.flatMap((record) => {
    const files = record.files.filter((file) => changed.has(comparablePath(file.path))
      || (file.oldPath ? changed.has(comparablePath(file.oldPath)) : false))
    return files.length ? [{ ...record, files }] : []
  })
}
