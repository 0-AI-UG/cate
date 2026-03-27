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
  sidebarVisible: boolean
  fileExplorerVisible: boolean
}

interface UIStoreActions {
  setShowNodeSwitcher: (show: boolean) => void
  setShowCommandPalette: (show: boolean) => void
  toggleSidebar: () => void
  toggleFileExplorer: () => void
  setSidebarVisible: (visible: boolean) => void
  setFileExplorerVisible: (visible: boolean) => void
}

export type UIStore = UIStoreState & UIStoreActions

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

export const useUIStore = create<UIStore>((set) => ({
  // --- State ---
  showNodeSwitcher: false,
  showCommandPalette: false,
  sidebarVisible: true,
  fileExplorerVisible: false,

  // --- Actions ---

  setShowNodeSwitcher(show) {
    set({ showNodeSwitcher: show })
  },

  setShowCommandPalette(show) {
    set({ showCommandPalette: show })
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
}))
