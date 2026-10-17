// =============================================================================
// treeCollapse — collapse state for the sidebar workspace tree (canvas rows, the
// Skills node, each agent group), persisted in the device's ui-state document
// so it survives a remount and an app restart.
//
// A key is present only while that row is COLLAPSED; absent = expanded, which is
// every row's default and keeps a freshly seen workspace fully open.
// =============================================================================

import { create } from 'zustand'
import { setUiState, subscribeUiState, uiState } from '../../app/state/uiState'

/** Keys are workspace-scoped so two workspaces can't share a canvas/agent row. */
export const canvasKey = (workspaceId: string, canvasId: string): string =>
  `${workspaceId}:canvas:${canvasId}`
export const skillsKey = (workspaceId: string): string => `${workspaceId}:skills`
export const skillAgentKey = (workspaceId: string, targetId: string): string =>
  `${workspaceId}:skills:${targetId}`

/** The ui-state list last mirrored into the store, to skip unrelated changes. */
let synced: string[] | undefined

function persisted(): string[] | undefined {
  return uiState()?.getSnapshot().sidebarTreeCollapsed
}

interface TreeCollapseState {
  collapsed: Set<string>
  toggle: (key: string) => void
}

export const useTreeCollapseStore = create<TreeCollapseState>((set) => ({
  collapsed: new Set(persisted() ?? []),
  toggle: (key) =>
    set((s) => {
      const next = new Set(s.collapsed)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      synced = [...next]
      setUiState('sidebarTreeCollapsed', synced)
      return { collapsed: next }
    }),
}))

subscribeUiState(() => {
  const keys = persisted()
  if (!keys || keys === synced) return
  synced = keys
  useTreeCollapseStore.setState({ collapsed: new Set(keys) })
})

/** True when the row is collapsed. Subscribes to just that key. */
export const useIsCollapsed = (key: string): boolean =>
  useTreeCollapseStore((s) => s.collapsed.has(key))

export const toggleCollapsed = (key: string): void => useTreeCollapseStore.getState().toggle(key)
