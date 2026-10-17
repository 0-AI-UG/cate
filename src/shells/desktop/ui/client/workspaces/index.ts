import { useSyncExternalStore } from 'react'
import type { WorkspaceList, WorkspaceListSnapshot } from '@client/workspaces'

export function useWorkspaceList(list: WorkspaceList): WorkspaceListSnapshot {
  return useSyncExternalStore(list.subscribe, list.getSnapshot)
}
