// Transient UI state of one client window: which workspace it shows, the
// command palette, the application overlay (settings, skills, ...), the
// sidebar, and the dialogs that open, join and share workspaces. Canvas tools, the worktree lens and relation editing belong to
// their own modules.

import { create } from 'zustand'
import type { Machine } from '@runtime/daemon/contract'
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
  /** "Join with a Code": open, with what to start from. */
  joinDialog: JoinRequest | null
  /** "Open…": the picker of machines and workspaces. */
  openDialogOpen: boolean
  /** The machine whose folder dialog is open. */
  machineFolder: Machine | null
  /** The workspace "Share" shows. */
  shareWorkspaceId: string | null
}

export interface JoinRequest {
  /** A pairing code or link to fill in (an opened `cate://pair` link). */
  code?: string
  /** The machine whose code to type (pairing again with a known one). */
  machine?: string
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
  openJoinDialog(request?: JoinRequest): void
  closeJoinDialog(): void
  setOpenDialogOpen(open: boolean): void
  openMachineFolder(machine: Machine | null): void
  openShare(workspaceId: string | null): void
}

export type UIStore = UIState & UIActions

export const INITIAL_UI_STATE: UIState = {
  selectedWorkspaceId: null,
  commandPaletteOpen: false,
  overlay: null,
  sidebarHidden: false,
  joinDialog: null,
  openDialogOpen: false,
  machineFolder: null,
  shareWorkspaceId: null,
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
  // Opening or joining leaves Settings: the workspace shows next.
  openJoinDialog: (request = {}) => set({ joinDialog: request, openDialogOpen: false, overlay: null }),
  closeJoinDialog: () => set({ joinDialog: null }),
  setOpenDialogOpen: (openDialogOpen) => set(openDialogOpen ? { openDialogOpen, overlay: null } : { openDialogOpen }),
  openMachineFolder: (machineFolder) => set({ machineFolder, openDialogOpen: false }),
  openShare: (shareWorkspaceId) => set({ shareWorkspaceId }),
}))

export const selectedWorkspaceId = (): string | null => useUIStore.getState().selectedWorkspaceId
