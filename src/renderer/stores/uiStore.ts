// =============================================================================
// UI Store — Zustand state for transient UI overlays and visibility toggles.
// =============================================================================

import { create } from 'zustand'
import type { SidebarView } from '../../shared/types'
import { useSettingsStore } from './settingsStore'

// -----------------------------------------------------------------------------
// Store interface
// -----------------------------------------------------------------------------

// Re-exported here so existing `from '../stores/uiStore'` imports keep working.
export type { SidebarView }

/** Active canvas interaction tool (Figma-style). */
export type CanvasTool = 'select' | 'hand'

interface UIStoreState {
  showCommandPalette: boolean
  /** Untitled editor to reuse when the palette was opened as an Open File picker. */
  openFileTargetPanelId: string | null
  showSkillsDialog: boolean
  /** Whether the minimap is currently expanded. */
  minimapOpen: boolean
  minimapOpenByCanvas: Record<string, boolean>
  showPullRequests: boolean
  showUsage: boolean
  showSettings: boolean
  /** Optional initial settings tab to open when showSettings flips to true. */
  settingsInitialTab: string | null
  /** Active marquee selection rectangle in canvas-space coordinates, or null when idle. */
  marquee: { startX: number; startY: number; currentX: number; currentY: number } | null
  /** Active canvas tool. Sticky: toggled via the toolbar or the Space key. */
  activeTool: CanvasTool
  /** Legacy test-harness navigation state. The visible left sidebar is always Workspaces. */
  activeLeftSidebarView: SidebarView | null
  /** Pending right-sidebar navigation request, consumed by the dock sidebar */
  requestedNavigationView: SidebarView | null
  /** When true the Workspace sidebar is fully hidden. */
  leftSidebarHidden: boolean
  /** Worktree being hovered (chip or sidebar row) — transiently highlights all
   *  its member nodes + sludge. Null when nothing is hovered. */
  hoveredWorktreeId: string | null
  /** Worktree the focus lens is locked onto — dims non-members, rings members,
   *  and (on entry) frames the camera. Null when the lens is off. */
  focusedWorktreeId: string | null
  /** Checkout used by file-navigation surfaces (Explorer, Search, Quick Open),
   *  keyed by workspace. Independent from the transient canvas focus lens. */
  navigationWorktreeByWorkspace: Record<string, string>
  /** Checkout whose index/working tree is shown by Source Control's Changes
   *  section, keyed by repository root so multi-repo workspaces stay isolated. */
  sourceControlWorktreeByRepository: Record<string, string>
}

interface UIStoreActions {
  setShowCommandPalette: (show: boolean) => void
  openFilePalette: (targetPanelId: string) => void
  setShowSkillsDialog: (show: boolean) => void
  setMinimapOpen: (open: boolean) => void
  toggleMinimapOpen: (canvasPanelId?: string) => void
  setShowPullRequests: (show: boolean) => void
  setShowUsage: (show: boolean) => void
  openSettings: (initialTab?: string) => void
  closeSettings: () => void
  toggleSidebar: () => void
  setMarquee: (marquee: { startX: number; startY: number; currentX: number; currentY: number } | null) => void
  setActiveTool: (tool: CanvasTool) => void
  setActiveLeftSidebarView: (view: SidebarView | null) => void
  requestNavigationView: (view: SidebarView | null) => void
  /** Show/hide the entire left sidebar (rail + content). */
  setLeftSidebarHidden: (hidden: boolean) => void
  /** Flip the left sidebar between fully hidden and shown. */
  toggleLeftSidebar: () => void
  /** Highlight (hover) a worktree's member nodes; pass null to clear. */
  setHoveredWorktree: (id: string | null) => void
  /** Lock the focus lens onto a worktree (caller frames the camera separately). */
  focusWorktree: (id: string | null) => void
  /** Clear both hover highlight and the focus lens. */
  clearWorktreeLens: () => void
  setNavigationWorktree: (workspaceId: string, worktreeId: string) => void
  setSourceControlWorktree: (repositoryRoot: string, worktreeId: string) => void
}

export type UIStore = UIStoreState & UIStoreActions

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

export const useUIStore = create<UIStore>((set, get) => ({
  // --- State ---
  showCommandPalette: false,
  openFileTargetPanelId: null,
  showSkillsDialog: false,
  minimapOpen: false,
  minimapOpenByCanvas: {},
  showPullRequests: false,
  showUsage: false,
  showSettings: false,
  settingsInitialTab: null,
  marquee: null,
  activeTool: 'select',
  activeLeftSidebarView: 'workspaces',
  requestedNavigationView: null,
  leftSidebarHidden: false,
  hoveredWorktreeId: null,
  focusedWorktreeId: null,
  navigationWorktreeByWorkspace: {},
  sourceControlWorktreeByRepository: {},

  // --- Actions ---

  setShowCommandPalette(show) {
    set({ showCommandPalette: show, ...(!show ? { openFileTargetPanelId: null } : {}) })
  },

  openFilePalette(targetPanelId) {
    set({ showCommandPalette: true, openFileTargetPanelId: targetPanelId })
  },

  setShowSkillsDialog(show) {
    set({ showSkillsDialog: show, ...(show ? { showPullRequests: false, showUsage: false, showSettings: false, settingsInitialTab: null } : {}) })
  },

  setMinimapOpen(open) {
    set({ minimapOpen: open })
  },

  toggleMinimapOpen(canvasPanelId) {
    if (canvasPanelId) {
      set((state) => ({ minimapOpenByCanvas: {
        ...state.minimapOpenByCanvas,
        [canvasPanelId]: !state.minimapOpenByCanvas[canvasPanelId],
      } }))
    } else {
      set({ minimapOpen: !get().minimapOpen })
    }
  },

  setShowPullRequests(show) {
    set({ showPullRequests: show, ...(show ? { showSkillsDialog: false, showUsage: false, showSettings: false, settingsInitialTab: null } : {}) })
  },

  setShowUsage(show) {
    set({ showUsage: show, ...(show ? { showPullRequests: false, showSkillsDialog: false, showSettings: false, settingsInitialTab: null } : {}) })
  },

  openSettings(initialTab) {
    set({ showPullRequests: false, showSkillsDialog: false, showUsage: false, showSettings: true, settingsInitialTab: initialTab ?? null })
  },

  closeSettings() {
    set({ showSettings: false, settingsInitialTab: null })
  },

  toggleSidebar() {
    set((state) => ({ leftSidebarHidden: !state.leftSidebarHidden }))
  },

  setMarquee(marquee) {
    set({ marquee })
  },

  setActiveTool(tool) {
    set({ activeTool: tool })
  },

  setActiveLeftSidebarView(view) {
    set({ activeLeftSidebarView: view })
  },

  requestNavigationView(view) {
    set({ requestedNavigationView: view })
  },

  setLeftSidebarHidden(hidden) {
    set({ leftSidebarHidden: hidden })
  },

  toggleLeftSidebar() {
    set((s) => ({ leftSidebarHidden: !s.leftSidebarHidden }))
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

  setNavigationWorktree(workspaceId, worktreeId) {
    set((state) => ({
      navigationWorktreeByWorkspace: {
        ...state.navigationWorktreeByWorkspace,
        [workspaceId]: worktreeId,
      },
    }))
  },

  setSourceControlWorktree(repositoryRoot, worktreeId) {
    set((state) => ({
      sourceControlWorktreeByRepository: {
        ...state.sourceControlWorktreeByRepository,
        [repositoryRoot]: worktreeId,
      },
    }))
  },

}))

// Apply the file panel launch preference once settings finish loading.
let launchSidebarViewApplied = false
function applyLaunchSidebarView(loaded: boolean): void {
  if (launchSidebarViewApplied || !loaded) return
  launchSidebarViewApplied = true
  const { showFileExplorerOnLaunch } = useSettingsStore.getState()
  if (!showFileExplorerOnLaunch) return
  if (useUIStore.getState().requestedNavigationView !== null) return
  useUIStore.getState().requestNavigationView('explorer')
}
applyLaunchSidebarView(useSettingsStore.getState()._loaded)
useSettingsStore.subscribe((s) => applyLaunchSidebarView(s._loaded))
