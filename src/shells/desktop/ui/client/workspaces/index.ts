import { useSyncExternalStore } from 'react'
import type { WorkspaceList, WorkspaceListSnapshot, WorkspaceEntry } from '@client/workspaces'

export function useWorkspaceList(list: WorkspaceList): WorkspaceListSnapshot {
  return useSyncExternalStore(list.subscribe, list.getSnapshot)
}

export function useRecentWorkspaces(list: WorkspaceList): readonly WorkspaceEntry[] {
  return useSyncExternalStore(list.subscribe, list.getRecentSnapshot)
}
