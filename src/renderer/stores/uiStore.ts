// =============================================================================
// UI Store — Zustand state for transient UI overlays and visibility toggles.
// =============================================================================

import { create } from 'zustand'

// -----------------------------------------------------------------------------
// Store interface
// -----------------------------------------------------------------------------

export type SidebarView = 'workspaces' | 'explorer' | 'git' | 'aiConfig' | 'usage'
export type SidebarSide = 'left' | 'right'

export interface SidebarLayout {
  left: SidebarView[]
  right: SidebarView[]
}

const LAYOUT_STORAGE_KEY = 'cate.sidebarLayout'
const ALL_VIEWS: SidebarView[] = ['workspaces', 'explorer', 'git', 'aiConfig', 'usage']
const DEFAULT_LAYOUT: SidebarLayout = {
  left: ['workspaces'],
  right: ['explorer', 'git', 'aiConfig', 'usage'],
}

function loadLayout(): SidebarLayout {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LAYOUT_STORAGE_KEY) : null
    if (!raw) return DEFAULT_LAYOUT
    const parsed = JSON.parse(raw) as SidebarLayout
    const left = (parsed.left ?? []).filter((v) => ALL_VIEWS.includes(v))
    const right = (parsed.right ?? []).filter((v) => ALL_VIEWS.includes(v))
    // Ensure every view is present exactly once — append missing ones to the right.
    const seen = new Set<SidebarView>([...left, ...right])
    for (const v of ALL_VIEWS) if (!seen.has(v)) right.push(v)
    return { left, right }
  } catch {
    return DEFAULT_LAYOUT
  }
}

function saveLayout(layout: SidebarLayout) {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout))
  } catch {
    // ignore
  }
}

interface UIStoreState {
  showNodeSwitcher: boolean
  showCommandPalette: boolean
  showPanelSwitcher: boolean
  showGlobalSearch: boolean
  showAISetupDialog: boolean
  showAIConfigDialog: boolean
  fileExplorerVisible: boolean
  /** Pre-captured page screenshot for panel switcher previews. */
  panelSwitcherScreenshot: string | null
  /** Active marquee selection rectangle in canvas-space coordinates, or null when idle. */
  marquee: { startX: number; startY: number; currentX: number; currentY: number } | null
  /** Layout: which views live on which side and in what order */
  sidebarLayout: SidebarLayout
  /** Active view on the left sidebar, null = collapsed */
  activeLeftSidebarView: SidebarView | null
  /** Active view on the right sidebar, null = collapsed */
  activeRightSidebarView: SidebarView | null
  /** The view currently being dragged between/within sidebars, null when idle */
  draggingView: SidebarView | null
}

interface UIStoreActions {
  setShowNodeSwitcher: (show: boolean) => void
  setShowCommandPalette: (show: boolean) => void
  setShowPanelSwitcher: (show: boolean) => void
  setShowGlobalSearch: (show: boolean) => void
  setShowAISetupDialog: (show: boolean) => void
  setShowAIConfigDialog: (show: boolean) => void
  toggleSidebar: () => void
  toggleFileExplorer: () => void
  setFileExplorerVisible: (visible: boolean) => void
  setMarquee: (marquee: { startX: number; startY: number; currentX: number; currentY: number } | null) => void
  setActiveLeftSidebarView: (view: SidebarView | null) => void
  setActiveRightSidebarView: (view: SidebarView | null) => void
  moveSidebarView: (view: SidebarView, targetSide: SidebarSide, targetIndex: number) => void
  setDraggingView: (view: SidebarView | null) => void
}

export type UIStore = UIStoreState & UIStoreActions

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

export const useUIStore = create<UIStore>((set, get) => ({
  // --- State ---
  showNodeSwitcher: false,
  showCommandPalette: false,
  showPanelSwitcher: false,
  panelSwitcherScreenshot: null,
  showGlobalSearch: false,
  showAISetupDialog: false,
  showAIConfigDialog: false,
  fileExplorerVisible: false,
  marquee: null,
  sidebarLayout: loadLayout(),
  activeLeftSidebarView: 'workspaces',
  activeRightSidebarView: null,
  draggingView: null,

  // --- Actions ---

  setShowNodeSwitcher(show) {
    set({ showNodeSwitcher: show })
  },

  setShowCommandPalette(show) {
    set({ showCommandPalette: show })
  },

  setShowPanelSwitcher(show) {
    set({ showPanelSwitcher: show })
  },

  setShowGlobalSearch(show) {
    set({ showGlobalSearch: show })
  },

  setShowAISetupDialog(show) {
    set({ showAISetupDialog: show })
  },

  setShowAIConfigDialog(show) {
    set({ showAIConfigDialog: show })
  },

  toggleSidebar() {
    // Toggles the left sidebar between collapsed (null) and the first view on the left.
    const { activeLeftSidebarView, sidebarLayout } = get()
    if (activeLeftSidebarView !== null) {
      set({ activeLeftSidebarView: null })
    } else {
      const first = sidebarLayout.left[0] ?? null
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

  setActiveLeftSidebarView(view) {
    set({ activeLeftSidebarView: view })
  },

  setActiveRightSidebarView(view) {
    set({ activeRightSidebarView: view })
  },

  moveSidebarView(view, targetSide, targetIndex) {
    const state = get()
    const layout: SidebarLayout = {
      left: state.sidebarLayout.left.slice(),
      right: state.sidebarLayout.right.slice(),
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

    saveLayout(layout)

    // Update active views: if the moved view was active on the source, clear it.
    // Focus it on the target side so the user sees where it landed.
    const patch: Partial<UIStoreState> = { sidebarLayout: layout }
    if (sourceSide === 'left' && state.activeLeftSidebarView === view) {
      patch.activeLeftSidebarView = null
    }
    if (sourceSide === 'right' && state.activeRightSidebarView === view) {
      patch.activeRightSidebarView = null
    }
    if (targetSide === 'left') patch.activeLeftSidebarView = view
    else patch.activeRightSidebarView = view

    set(patch as UIStoreState)
  },

  setDraggingView(view) {
    set({ draggingView: view })
  },

}))
