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
      let serialized = ''
      let pending = false
      const poll = async () => {
        if (pending) return
        pending = true
        clearTimeout(timer)
        try {
          const records = await window.electronAPI.agentChangesList(cwd, workspaceId)
          if (stopped) return
          const next = JSON.stringify(records)
          if (next !== serialized || entry.snapshot.error || entry.snapshot.loading) {
            serialized = next
            entry.snapshot = { records, loading: false }
            entry.listeners.forEach((notify) => notify())
          }
        } catch (cause) {
          if (stopped) return
          entry.snapshot = { ...entry.snapshot, loading: false, error: cause instanceof Error ? cause.message : 'Could not load recorded changes' }
          entry.listeners.forEach((notify) => notify())
        }
        pending = false
        if (!stopped) timer = setTimeout(poll, 2000)
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
