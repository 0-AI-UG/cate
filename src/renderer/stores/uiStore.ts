// =============================================================================
// UI Store — Zustand state for transient UI overlays and visibility toggles.
// =============================================================================

import { create } from 'zustand'

// -----------------------------------------------------------------------------
// Store interface
// -----------------------------------------------------------------------------

interface UIStoreState {
  showNodeSwitcher: boolean
  showCommandPalette: boolean
  showPanelSwitcher: boolean
  showGlobalSearch: boolean
  sidebarVisible: boolean
  fileExplorerVisible: boolean
  /** Pre-captured page screenshot for panel switcher previews. */
  panelSwitcherScreenshot: string | null
  rightSidebarVisible: boolean
  rightSidebarActiveTab: string
  rightSidebarDetached: boolean
}

interface UIStoreActions {
  setShowNodeSwitcher: (show: boolean) => void
  setShowCommandPalette: (show: boolean) => void
  setShowPanelSwitcher: (show: boolean) => void
  setShowGlobalSearch: (show: boolean) => void
  toggleSidebar: () => void
  toggleFileExplorer: () => void
  setSidebarVisible: (visible: boolean) => void
  setFileExplorerVisible: (visible: boolean) => void
  toggleRightSidebar: () => void
  setRightSidebarTab: (tab: string) => void
  setRightSidebarVisible: (visible: boolean) => void
  setRightSidebarDetached: (detached: boolean) => void
}

export type UIStore = UIStoreState & UIStoreActions

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

export const useUIStore = create<UIStore>((set) => ({
  // --- State ---
  showNodeSwitcher: false,
  showCommandPalette: false,
  showPanelSwitcher: false,
  panelSwitcherScreenshot: null,
  showGlobalSearch: false,
  sidebarVisible: true,
  fileExplorerVisible: false,
  rightSidebarVisible: false,
  rightSidebarActiveTab: 'git',
  rightSidebarDetached: false,

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

  toggleSidebar() {
    set((state) => ({ sidebarVisible: !state.sidebarVisible }))
  },

  toggleFileExplorer() {
    set((state) => ({ fileExplorerVisible: !state.fileExplorerVisible }))
  },

  setSidebarVisible(visible) {
    set({ sidebarVisible: visible })
  },

  setFileExplorerVisible(visible) {
    set({ fileExplorerVisible: visible })
  },

  toggleRightSidebar() {
    set((state) => ({ rightSidebarVisible: !state.rightSidebarVisible }))
  },
  setRightSidebarTab(tab) {
    set({ rightSidebarActiveTab: tab, rightSidebarVisible: true })
  },
  setRightSidebarVisible(visible) {
    set({ rightSidebarVisible: visible })
  },
  setRightSidebarDetached(detached) {
    set({ rightSidebarDetached: detached })
  },
}))
