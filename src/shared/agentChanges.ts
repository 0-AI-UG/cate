import type { AgentId } from './agents'
import type { GitDiffHunk } from './types'

/** Agent identity owns a change. A panel is only a place that displayed it. */
export interface AgentChangeRecord {
  id: string
  agentId: AgentId
  sessionId: string
  turnId: string
  parentSessionId?: string
  source: 'terminal' | 't3'
  sourceId: string
  panelId?: string
  panelIds?: string[]
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

export function effectiveAgentChanges(records: readonly AgentChangeRecord[]): AgentChangeRecord[] {
  const snapshots = new Map<string, AgentChangeRecord>()
  const key = (r: AgentChangeRecord) => JSON.stringify([r.source, r.agentId, r.sessionId, r.turnId])
  for (const record of records) {
    if (record.mode !== 'snapshot') continue
    const previous = snapshots.get(key(record))
    if (!previous || previous.createdAt <= record.createdAt) snapshots.set(key(record), record)
  }
  return records.filter((r) => !snapshots.has(key(r)) || snapshots.get(key(r)) === r)
}

export function filterAgentChanges(
  records: readonly AgentChangeRecord[],
  filter: AgentChangesFilter,
  /** The current conversation also matches when opened in another panel. */
  panelThreadId?: string,
): AgentChangeRecord[] {
  return effectiveAgentChanges(records).filter((r) =>
    (!filter.agentId || r.agentId === filter.agentId)
    && (!filter.panelId || r.panelId === filter.panelId || r.panelIds?.includes(filter.panelId) || (r.source === 't3' && r.sourceId === panelThreadId))
    && (!filter.sessionId || r.sessionId === filter.sessionId || r.parentSessionId === filter.sessionId)
    && (!filter.turnId || r.turnId === filter.turnId),
  )
}

/** Counts describe recorded edits, not the current checkout's net Git diff. */
export function summarizeAgentChanges(records: readonly AgentChangeRecord[]) {
  const files = new Map<string, { path: string; kind: 'modified'; additions: number; deletions: number }>()
  for (const record of effectiveAgentChanges(records)) for (const file of record.files) {
    const previous = files.get(file.path) ?? { path: file.path, kind: 'modified' as const, additions: 0, deletions: 0 }
    files.set(file.path, { ...previous, additions: previous.additions + file.additions, deletions: previous.deletions + file.deletions })
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path))
}
