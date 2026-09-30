import { useSyncExternalStore } from 'react'
import type { WorkspaceList, WorkspaceListSnapshot } from '../workspaceList'

export function useWorkspaceList(list: WorkspaceList): WorkspaceListSnapshot {
  return useSyncExternalStore(list.subscribe, list.getSnapshot)
}
