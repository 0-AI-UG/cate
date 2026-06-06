// =============================================================================
// UI Store — Zustand state for transient UI overlays and visibility toggles.
// =============================================================================

import { useMemo } from 'react'
import { create } from 'zustand'
import type { SidebarView, SidebarLayout } from '../../shared/types'
import { useSettingsStore } from './settingsStore'

// -----------------------------------------------------------------------------
// Store interface
// -----------------------------------------------------------------------------

// SidebarView / SidebarLayout now live in shared/types (they're persisted in
// settings.json); re-exported here so existing `from '../stores/uiStore'`
// imports keep working.
export type { SidebarView, SidebarLayout }
export type SidebarSide = 'left' | 'right'

/** Active canvas interaction tool (Figma-style). */
export type CanvasTool = 'select' | 'hand'

const ALL_VIEWS: SidebarView[] = ['workspaces', 'explorer', 'git', 'search']

/** Filter to known views and ensure every view appears exactly once (missing
 *  ones appended to the right). Tolerates partial/legacy/hand-edited shapes. */
export function normalizeSidebarLayout(raw: Partial<SidebarLayout> | null | undefined): SidebarLayout {
  const left = (raw?.left ?? []).filter((v) => ALL_VIEWS.includes(v))
  const right = (raw?.right ?? []).filter((v) => ALL_VIEWS.includes(v))
  const seen = new Set<SidebarView>([...left, ...right])
  for (const v of ALL_VIEWS) if (!seen.has(v)) right.push(v)
  return { left, right }
}

// The sidebar layout lives SOLELY in settingsStore (persisted in settings.json).
// uiStore holds only the transient sidebar state (active views, drag). Read the
// layout via `getSidebarLayout()` (or the `useSidebarLayout` selector in
// components) so there is a single source of truth and no hand-sync.
export function getSidebarLayout(): SidebarLayout {
  return normalizeSidebarLayout(useSettingsStore.getState().sidebarLayout)
}

interface UIStoreState {
  showNodeSwitcher: boolean
  showCommandPalette: boolean
  showLayoutsDialog: boolean
  /** Bumped whenever a saved layout is created/deleted, so open surfaces
   *  (dialog, empty-canvas overlay) can re-list. */
  layoutsVersion: number
  /** Whether the minimap is currently expanded. */
  minimapOpen: boolean
  showSettings: boolean
  /** Optional initial settings tab to open when showSettings flips to true. */
  settingsInitialTab: string | null
  fileExplorerVisible: boolean
  /** Active marquee selection rectangle in canvas-space coordinates, or null when idle. */
  marquee: { startX: number; startY: number; currentX: number; currentY: number } | null
  /** Active canvas tool. Sticky: changed via toolbar or V/H shortcuts. */
  activeTool: CanvasTool
  /** True while Spacebar is held — temporarily overrides `activeTool` with Hand. */
  spacePanActive: boolean
  /** Active view on the left sidebar, null = collapsed */
  activeLeftSidebarView: SidebarView | null
  /** Active view on the right sidebar, null = collapsed */
  activeRightSidebarView: SidebarView | null
  /** The view currently being dragged between/within sidebars, null when idle */
  draggingView: SidebarView | null
  /** Worktree being hovered (chip or sidebar row) — transiently highlights all
   *  its member nodes + sludge. Null when nothing is hovered. */
  hoveredWorktreeId: string | null
  /** Worktree the focus lens is locked onto — dims non-members, rings members,
   *  and (on entry) frames the camera. Null when the lens is off. */
  focusedWorktreeId: string | null
}

interface UIStoreActions {
  setShowNodeSwitcher: (show: boolean) => void
  setShowCommandPalette: (show: boolean) => void
  setShowLayoutsDialog: (show: boolean) => void
  bumpLayoutsVersion: () => void
  setMinimapOpen: (open: boolean) => void
  toggleMinimapOpen: () => void
  openSettings: (initialTab?: string) => void
  closeSettings: () => void
  toggleSidebar: () => void
  toggleFileExplorer: () => void
  setFileExplorerVisible: (visible: boolean) => void
  setMarquee: (marquee: { startX: number; startY: number; currentX: number; currentY: number } | null) => void
  setActiveTool: (tool: CanvasTool) => void
  setSpacePanActive: (active: boolean) => void
  setActiveLeftSidebarView: (view: SidebarView | null) => void
  setActiveRightSidebarView: (view: SidebarView | null) => void
  moveSidebarView: (view: SidebarView, targetSide: SidebarSide, targetIndex: number) => void
  setDraggingView: (view: SidebarView | null) => void
  /** Highlight (hover) a worktree's member nodes; pass null to clear. */
  setHoveredWorktree: (id: string | null) => void
  /** Lock the focus lens onto a worktree (caller frames the camera separately). */
  focusWorktree: (id: string | null) => void
  /** Clear both hover highlight and the focus lens. */
  clearWorktreeLens: () => void
}

export type UIStore = UIStoreState & UIStoreActions

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

export const useUIStore = create<UIStore>((set, get) => ({
  // --- State ---
  showNodeSwitcher: false,
  showCommandPalette: false,
  showLayoutsDialog: false,
  layoutsVersion: 0,
  minimapOpen: false,
  showSettings: false,
  settingsInitialTab: null,
  fileExplorerVisible: false,
  marquee: null,
  activeTool: 'select',
  spacePanActive: false,
  activeLeftSidebarView: 'workspaces',
  activeRightSidebarView: null,
  draggingView: null,
  hoveredWorktreeId: null,
  focusedWorktreeId: null,

  // --- Actions ---

  setShowNodeSwitcher(show) {
    set({ showNodeSwitcher: show })
  },

  setShowCommandPalette(show) {
    set({ showCommandPalette: show })
  },

  setShowLayoutsDialog(show) {
    set({ showLayoutsDialog: show })
  },

  bumpLayoutsVersion() {
    set((s) => ({ layoutsVersion: s.layoutsVersion + 1 }))
  },

  setMinimapOpen(open) {
    set({ minimapOpen: open })
  },

  toggleMinimapOpen() {
    set({ minimapOpen: !get().minimapOpen })
  },

  openSettings(initialTab) {
    set({ showSettings: true, settingsInitialTab: initialTab ?? null })
  },

  closeSettings() {
    set({ showSettings: false, settingsInitialTab: null })
  },

  toggleSidebar() {
    // Toggles the left sidebar between collapsed (null) and the first view on the left.
    const { activeLeftSidebarView } = get()
    if (activeLeftSidebarView !== null) {
      set({ activeLeftSidebarView: null })
    } else {
      const first = getSidebarLayout().left[0] ?? null
      set({ activeLeftSidebarView: first })
    }
  },

  toggleFileExplorer() {
    set((state) => ({ fileExplorerVisible: !state.fileExplorerVisible }))
  },

  setFileExplorerVisible(visible) {
    set({ fileExplorerVisible: visible })
  },

  setMarquee(marquee) {
    set({ marquee })
  },

  setActiveTool(tool) {
    set({ activeTool: tool })
  },

  setSpacePanActive(active) {
    set({ spacePanActive: active })
  },

  setActiveLeftSidebarView(view) {
    set({ activeLeftSidebarView: view })
  },

  setActiveRightSidebarView(view) {
    set({ activeRightSidebarView: view })
  },

  moveSidebarView(view, targetSide, targetIndex) {
    const state = get()
    // The layout's single home is settingsStore; read + write it there.
    const current = getSidebarLayout()
    const layout: SidebarLayout = {
      left: current.left.slice(),
      right: current.right.slice(),
    }
    // Determine source side and index
    let sourceSide: SidebarSide | null = null
    let sourceIndex = -1
    if ((sourceIndex = layout.left.indexOf(view)) >= 0) sourceSide = 'left'
    else if ((sourceIndex = layout.right.indexOf(view)) >= 0) sourceSide = 'right'
    if (sourceSide === null) return

    // Remove from source
    layout[sourceSide].splice(sourceIndex, 1)

    // Adjust targetIndex if removing from the same array shifted items
    let insertAt = targetIndex
    if (sourceSide === targetSide && sourceIndex < targetIndex) insertAt -= 1
    insertAt = Math.max(0, Math.min(insertAt, layout[targetSide].length))
    layout[targetSide].splice(insertAt, 0, view)

    // Persist to settingsStore (the single source of truth). The broadcast funnel
    // projects it back to every window; components read it via useSidebarLayout.
    useSettingsStore.getState().setSetting('sidebarLayout', layout)

    // Update active views (transient, uiStore-owned): if the moved view was
    // active on the source, clear it; focus it on the target side so the user
    // sees where it landed.
    const patch: Partial<UIStoreState> = {}
    if (sourceSide === 'left' && state.activeLeftSidebarView === view) {
      patch.activeLeftSidebarView = null
    }
    if (sourceSide === 'right' && state.activeRightSidebarView === view) {
      patch.activeRightSidebarView = null
    }
    if (targetSide === 'left') patch.activeLeftSidebarView = view
    else patch.activeRightSidebarView = view

    set(patch)
  },

  setDraggingView(view) {
    set({ draggingView: view })
  },

  setHoveredWorktree(id) {
    if (get().hoveredWorktreeId === id) return
    set({ hoveredWorktreeId: id })
  },

  focusWorktree(id) {
    set({ focusedWorktreeId: id })
  },

  clearWorktreeLens() {
    const { hoveredWorktreeId, focusedWorktreeId } = get()
    if (hoveredWorktreeId === null && focusedWorktreeId === null) return
    set({ hoveredWorktreeId: null, focusedWorktreeId: null })
  },

}))

/**
 * Subscribe to the sidebar layout (its single home is settingsStore). Components
 * use this instead of reading a uiStore copy, so there's no hand-sync and no
 * stale path when the layout changes via UI, hand-edit, or another window.
 */
export function useSidebarLayout(): SidebarLayout {
  // Select the stable raw field and normalize in a memo: normalizeSidebarLayout
  // builds a fresh {left,right} every call, so selecting it directly would return
  // a new reference on every render and, under zustand v5's snapshot identity
  // check, spin useSyncExternalStore into "Maximum update depth exceeded".
  const raw = useSettingsStore((s) => s.sidebarLayout)
  return useMemo(() => normalizeSidebarLayout(raw), [raw])
}

/**
 * Resolve the tool currently in effect. Space-hold temporarily forces Hand
 * without disturbing the sticky `activeTool`, so releasing Space reverts cleanly.
 */
export function effectiveCanvasTool(
  s: Pick<UIStoreState, 'activeTool' | 'spacePanActive'>,
): CanvasTool {
  return s.spacePanActive ? 'hand' : s.activeTool
}
