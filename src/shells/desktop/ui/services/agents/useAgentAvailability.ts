import { useCallback, useSyncExternalStore } from 'react'
import { acquireAgentAvailability, peekAgentAvailability } from '@services/agents/client'

/** A mirror of the runtime's state, with no client inspection or cache. */
export function useAgentAvailability(workspaceId: string | null | undefined) {
  const subscribe = useCallback((listener: () => void) => {
    if (!workspaceId) return () => {}
    const handle = acquireAgentAvailability(workspaceId)
    const off = handle.subscribe(listener)
    return () => { off(); handle.release() }
  }, [workspaceId])
  const read = useCallback(() => workspaceId ? peekAgentAvailability(workspaceId) : null, [workspaceId])
  return useSyncExternalStore(subscribe, read)
}
