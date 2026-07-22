// =============================================================================
// treeCollapse — collapse state for the sidebar workspace tree (canvas rows, the
// Skills node, each agent group), persisted to localStorage so it survives a
// remount and an app restart.
//
// A key is present only while that row is COLLAPSED; absent = expanded, which is
// every row's default and keeps a freshly seen workspace fully open.
// =============================================================================

import { create } from 'zustand'

const STORAGE_KEY = 'cate.sidebar.treeCollapsed'

/** Keys are workspace-scoped so two workspaces can't share a canvas/agent row. */
export const canvasKey = (workspaceId: string, canvasId: string): string =>
  `${workspaceId}:canvas:${canvasId}`
export const skillsKey = (workspaceId: string): string => `${workspaceId}:skills`
export const skillAgentKey = (workspaceId: string, targetId: string): string =>
  `${workspaceId}:skills:${targetId}`

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set(parsed.filter((k): k is string => typeof k === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

function save(keys: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...keys]))
  } catch {
    // Storage full / unavailable — collapse state is a nicety, never fail on it.
  }
}

interface TreeCollapseState {
  collapsed: Set<string>
  toggle: (key: string) => void
}

export const useTreeCollapseStore = create<TreeCollapseState>((set) => ({
  collapsed: load(),
  toggle: (key) =>
    set((s) => {
      const next = new Set(s.collapsed)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      save(next)
      return { collapsed: next }
    }),
}))

/** True when the row is collapsed. Subscribes to just that key. */
export const useIsCollapsed = (key: string): boolean =>
  useTreeCollapseStore((s) => s.collapsed.has(key))

export const toggleCollapsed = (key: string): void => useTreeCollapseStore.getState().toggle(key)
