// React bindings of the host's stores, for the desktop UI.

import { useSyncExternalStore } from 'react'
import { useDocument } from '../document'
import { actionsVersion, subscribeActions } from '@client/host'
import { keepMountedPanelIds, setEqual } from '@client/host'
import { demandedSurfaces, subscribeDemandedSurfaces } from '@client/host'

/** Re-renders when actions are declared or bound. */
export function useActionsVersion(): number {
  return useSyncExternalStore(subscribeActions, actionsVersion)
}

export function useDemandedSurfaces(): ReadonlyMap<string, number> {
  return useSyncExternalStore(subscribeDemandedSurfaces, demandedSurfaces, demandedSurfaces)
}

export function useKeepMountedPanelIds(workspaceId: string): ReadonlySet<string> {
  return useDocument(workspaceId, keepMountedPanelIds, setEqual)
}
