// =============================================================================
// App Store — cross-window sync slice (merge metadata from main broadcast).
// setupWorkspaceSync lives in index.ts so it can close over the created store
// directly (avoids a syncSlice -> index import edge).
// =============================================================================

import type { AppSet, AppGet, AppStoreActions } from './types'
import { isRemoteRuntimeConnection } from '../../../shared/runtimeConnection'

type SyncSliceActions = Pick<AppStoreActions, 'mergeWorkspaceInfos'>

export function createSyncSlice(set: AppSet, _get: AppGet): SyncSliceActions {
  return {
    mergeWorkspaceInfos(infos) {
      set((state) => {
        const existingMap = new Map(state.workspaces.map((ws) => [ws.id, ws]))

        // Update metadata for existing workspaces, add new ones
        const updatedIds = new Set<string>()
        for (const info of infos) {
          updatedIds.add(info.id)
          const existing = existingMap.get(info.id)
          if (existing) {
            // Merge metadata only — don't touch panels/canvas state
            if (
              existing.name !== info.name ||
              existing.color !== info.color ||
              existing.rootPath !== info.rootPath ||
              (isRemoteRuntimeConnection(existing.connection) ? existing.connection.runtimeId : undefined) !==
                (isRemoteRuntimeConnection(info.connection) ? info.connection.runtimeId : undefined)
            ) {
            existingMap.set(info.id, {
              ...existing,
              name: info.name,
              color: info.color,
              rootPath: info.rootPath,
              connection: info.connection ?? existing.connection,
              rootPathError: null,
              isRootPathPending: false,
            })
            }
          } else {
            // New workspace from another window — create empty local state
            existingMap.set(info.id, {
              id: info.id,
              name: info.name,
              color: info.color,
              rootPath: info.rootPath,
              connection: info.connection,
              rootPathError: null,
              isRootPathPending: false,
              panels: {},
            })
          }
        }

        // Remove workspaces that no longer exist in main (deleted from another window)
        // But keep the currently selected workspace to avoid breaking the UI
        const workspaces = Array.from(existingMap.values()).filter(
          (ws) => updatedIds.has(ws.id) || ws.id === state.selectedWorkspaceId,
        )

        return { workspaces }
      })
    },
  }
}
