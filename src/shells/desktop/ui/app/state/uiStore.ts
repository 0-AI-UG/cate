// Transient UI state of one client window: which workspace it shows, the
// command palette, the application overlay (settings, skills, ...) and the
// sidebar. Canvas tools, the worktree lens and relation editing belong to
// their own modules.

import { create } from 'zustand'
import { desktopPort } from '../desktop'

export interface OverlayRequest {
  /** A registered overlay view: 'settings' or one a module registers. */
  view: string
  /** A section inside it (a settings page id, a tab). */
  section?: string
}

export interface UIState {
  /** The workspace this window shows; null on the welcome screen. */
  selectedWorkspaceId: string | null
  commandPaletteOpen: boolean
  overlay: OverlayRequest | null
  sidebarHidden: boolean
  /** Set by "Join a workspace" and the welcome screen. */
  joinDialogOpen: boolean
}

export interface UIActions {
  setSelectedWorkspace(workspaceId: string | null): void
  setCommandPaletteOpen(open: boolean): void
  openOverlay(request: OverlayRequest): void
  closeOverlay(): void
  openSettings(section?: string): void
  toggleSettings(): void
  setSidebarHidden(hidden: boolean): void
  toggleSidebar(): void
  setJoinDialogOpen(open: boolean): void
}

export type UIStore = UIState & UIActions

export const INITIAL_UI_STATE: UIState = {
  selectedWorkspaceId: null,
  commandPaletteOpen: false,
  overlay: null,
  sidebarHidden: false,
  joinDialogOpen: false,
}

export const useUIStore = create<UIStore>((set, get) => ({
  ...INITIAL_UI_STATE,
  setSelectedWorkspace: (selectedWorkspaceId) => set({ selectedWorkspaceId }),
  setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
  openOverlay(request) {
    // A detached window has no room for an overlay; the main window shows it.
    if (desktopPort()?.showOverlayInMainWindow?.(request)) return
    set({ overlay: request })
  },
  closeOverlay: () => set({ overlay: null }),
  openSettings: (section) => get().openOverlay({ view: 'settings', ...(section ? { section } : {}) }),
  toggleSettings() {
    if (get().overlay?.view === 'settings') get().closeOverlay()
    else get().openSettings()
  },
  setSidebarHidden: (sidebarHidden) => set({ sidebarHidden }),
  toggleSidebar: () => set((s) => ({ sidebarHidden: !s.sidebarHidden })),
  setJoinDialogOpen: (joinDialogOpen) => set({ joinDialogOpen }),
}))

export const selectedWorkspaceId = (): string | null => useUIStore.getState().selectedWorkspaceId
