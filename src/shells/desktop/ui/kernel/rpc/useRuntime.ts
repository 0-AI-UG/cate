import { useSyncExternalStore } from 'react'
import type { RuntimeProxy } from '@kernel/rpc/contract'
import { runtimesVersion, subscribeRuntimes, tryRuntimeFor } from '@kernel/rpc/client'

/** The typed proxy of a workspace's runtime, or null while the workspace is
 *  not open. Re-renders when runtimes appear or go. */
export function useRuntime(workspaceId: string | null | undefined): RuntimeProxy | null {
  useSyncExternalStore(subscribeRuntimes, runtimesVersion)
  return workspaceId ? tryRuntimeFor(workspaceId) : null
}
