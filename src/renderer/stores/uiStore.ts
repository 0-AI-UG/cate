// =============================================================================
// UI Store — Zustand state for transient UI overlays and visibility toggles.
// =============================================================================

import { create } from 'zustand'

// -----------------------------------------------------------------------------
// Store interface
// -----------------------------------------------------------------------------

export type SidebarView = 'workspaces' | 'explorer' | 'git' | 'aiConfig'

interface UIStoreState {
  showNodeSwitcher: boolean
  showCommandPalette: boolean
  showPanelSwitcher: boolean
  showGlobalSearch: boolean
  showAISetupDialog: boolean
  showAIConfigDialog: boolean
  sidebarVisible: boolean
  fileExplorerVisible: boolean
  /** Pre-captured page screenshot for panel switcher previews. */
  panelSwitcherScreenshot: string | null
  /** Active marquee selection rectangle in canvas-space coordinates, or null when idle. */
  marquee: { startX: number; startY: number; currentX: number; currentY: number } | null
  /** Active view in the right sidebar, null = collapsed */
  activeRightSidebarView: SidebarView | null
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
  setSidebarVisible: (visible: boolean) => void
  setFileExplorerVisible: (visible: boolean) => void
  setMarquee: (marquee: { startX: number; startY: number; currentX: number; currentY: number } | null) => void
  setActiveRightSidebarView: (view: SidebarView | null) => void
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
  showAISetupDialog: false,
  showAIConfigDialog: false,
  sidebarVisible: true,
  fileExplorerVisible: false,
  marquee: null,
  activeRightSidebarView: null,

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

  setMarquee(marquee) {
    set({ marquee })
  },

  setActiveRightSidebarView(view) {
    set({ activeRightSidebarView: view })
  },

}))
