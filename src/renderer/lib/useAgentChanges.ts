import { useEffect, useSyncExternalStore } from 'react'
import type { AgentChangeRecord } from '../../shared/agentChanges'

interface Snapshot { records: AgentChangeRecord[]; loading: boolean; error?: string }
const empty: Snapshot = { records: [], loading: true }
const entries = new Map<string, { snapshot: Snapshot; listeners: Set<() => void>; stop?: () => void; refresh?: () => Promise<void> }>()

export async function refreshAgentChanges(cwd: string, workspaceId: string): Promise<void> {
  await entries.get(JSON.stringify([workspaceId, cwd]))?.refresh?.()
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
