import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { effectiveAgentChanges, type AgentChangeRecord } from '../../shared/agentChanges'
import type { GitStatusSnapshot } from '../stores/gitStatusStore'
import { useGitStatusSnapshot } from '../stores/gitStatusStore'

interface Snapshot { records: AgentChangeRecord[]; loading: boolean; error?: string }
const empty: Snapshot = { records: [], loading: true }
const entries = new Map<string, { snapshot: Snapshot; listeners: Set<() => void>; stop?: () => void; refresh?: () => Promise<void> }>()

export async function refreshAgentChanges(cwd: string, workspaceId: string): Promise<void> {
  await entries.get(JSON.stringify([workspaceId, cwd]))?.refresh?.()
}

function comparablePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** Recorded edits that are still represented by a staged or unstaged file in
 * the checkout. The durable records remain available as history. */
export function activeAgentChanges(records: readonly AgentChangeRecord[], git: GitStatusSnapshot): AgentChangeRecord[] {
  const effective = effectiveAgentChanges(records)
  if (!git.isRepo) return effective
  const changed = new Set(git.statusFiles.map((file) => comparablePath(file.path)))
  return effective.flatMap((record) => {
    const files = record.files.filter((file) => changed.has(comparablePath(file.path))
      || (file.oldPath ? changed.has(comparablePath(file.oldPath)) : false))
    return files.length ? [{ ...record, files }] : []
  })
}

/** One poll per checkout/window, shared by every T3 guest and diff panel. */
export function useAgentChanges(cwd: string, workspaceId: string): Snapshot {
  const key = JSON.stringify([workspaceId, cwd])
  if (!entries.has(key)) entries.set(key, { snapshot: empty, listeners: new Set() })
  const entry = entries.get(key)!
  const snapshot = useSyncExternalStore(
    (listener) => { entry.listeners.add(listener); return () => { entry.listeners.delete(listener) } },
    () => entry.snapshot,
  )
  useEffect(() => {
    if (!entry.stop && cwd) {
      let stopped = false
      let timer: ReturnType<typeof setTimeout>
      let revision: string | undefined
      let pending: Promise<void> | undefined
      const poll = (): Promise<void> => {
        if (pending) return pending
        clearTimeout(timer)
        pending = (async () => {
          try {
            const result = await window.electronAPI.agentChangesRead(cwd, workspaceId, revision)
            if (stopped) return
            revision = result.revision
            if (result.records || entry.snapshot.error || entry.snapshot.loading) {
              entry.snapshot = { records: result.records ?? entry.snapshot.records, loading: false }
              entry.listeners.forEach((notify) => notify())
            }
          } catch (cause) {
            if (stopped) return
            entry.snapshot = { ...entry.snapshot, loading: false, error: cause instanceof Error ? cause.message : 'Could not load recorded changes' }
            entry.listeners.forEach((notify) => notify())
          } finally {
            pending = undefined
            if (!stopped) timer = setTimeout(poll, 2000)
          }
        })()
        return pending
      }
      entry.refresh = poll
      entry.stop = () => { stopped = true; clearTimeout(timer); entry.stop = undefined; entry.refresh = undefined }
      void poll()
    }
    return () => {
      // useSyncExternalStore unsubscribes during the same cleanup cycle.
      queueMicrotask(() => { if (!entry.listeners.size) { entry.stop?.(); entries.delete(key) } })
    }
  }, [cwd, workspaceId, entry, key])
  return snapshot
}

/** Agent edits scoped to files which are currently dirty in this checkout. */
export function useActiveAgentChanges(cwd: string, workspaceId: string): Snapshot {
  const history = useAgentChanges(cwd, workspaceId)
  const git = useGitStatusSnapshot(cwd)
  return useMemo(() => ({
    ...history,
    records: git.revision === 0 ? [] : activeAgentChanges(history.records, git),
    loading: history.loading || git.revision === 0,
  }), [history, git])
}
