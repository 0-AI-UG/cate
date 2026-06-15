// =============================================================================
// App Store — type definitions (state + actions interfaces).
// =============================================================================

import type { StoreApi } from 'zustand'
import type {
  WorkspaceState,
  WorkspaceInfo,
  PanelState,
  PanelType,
  Point,
  Size,
  DockZonePosition,
  WorktreeMeta,
  RemoteConnectSpec,
  CompanionConnection,
  CompanionPhase,
} from '../../../shared/types'

// -----------------------------------------------------------------------------
// Panel placement — specifies where a newly created panel should go
// -----------------------------------------------------------------------------

export type PanelPlacement =
  /** `canvasPanelId` pins the create to a SPECIFIC canvas (the one the toolbar /
   *  right-click menu / drop originated from). Without it, placement routes to
   *  the workspace's primary canvas — correct for session restore and auto
   *  creates, but wrong for an interactive create on a secondary/nested canvas.
   *  `size` pins the node's size (used by layout restore to reproduce the saved
   *  geometry exactly); without it the panel type's default size is used. */
  | { target: 'canvas'; position?: Point; canvasPanelId?: string; size?: Size }
  /** `stackId` docks the panel as a new tab in a SPECIFIC stack (the one the
   *  user is working in — e.g. the focused pane of a split). Without it the
   *  panel lands in the zone's default stack. A stale stackId falls back to the
   *  zone (dockPanel handles that). */
  | { target: 'dock'; zone: DockZonePosition; stackId?: string }
  | { target: 'auto' } // default: canvas
  /** No global routing — caller (e.g. canvas-node mini-dock) will place the
   *  panel itself into a private DockStore. The panel is added to the
   *  workspace.panels record only. */
  | { target: 'none' }

// -----------------------------------------------------------------------------
// Store interface
// -----------------------------------------------------------------------------

export interface AppStoreState {
  workspaces: WorkspaceState[]
  selectedWorkspaceId: string
  /** Phase of the built-in LOCAL companion daemon (a process-wide singleton, so
   *  it's global rather than per-workspace). Drives the local loading blocker.
   *  `null` until seeded at init. */
  localCompanionPhase: CompanionPhase | null
  /** Per-workspace reload counter. Bumped when a workspace's layout is rebuilt
   *  from disk (reload / hydrate), so the main shell can remount and respawn its
   *  terminals cleanly. Defaults to 0 for any workspace not present here. */
  reloadEpochs: Record<string, number>
}

export interface AppStoreActions {
  // Workspace management
  addWorkspace: (name?: string, rootPath?: string, id?: string, connection?: CompanionConnection) => string
  selectWorkspace: (id: string) => Promise<void>
  removeWorkspace: (id: string, forgetRecent?: boolean) => void

  // Panel creation — each adds a PanelState to the workspace AND places it
  createTerminal: (workspaceId: string, initialInput?: string, position?: Point, placement?: PanelPlacement, cwd?: string) => string
  createBrowser: (workspaceId: string, url?: string, position?: Point, placement?: PanelPlacement, proxyUrl?: string) => string
  createEditor: (workspaceId: string, filePath?: string, position?: Point, placement?: PanelPlacement) => string
  createDiffEditor: (workspaceId: string, filePath: string, diffMode: 'staged' | 'working', position?: Point, placement?: PanelPlacement) => string
  createCanvas: (workspaceId: string, position?: Point, placement?: PanelPlacement) => string
  createAgent: (workspaceId: string, position?: Point, placement?: PanelPlacement) => string
  createDocument: (workspaceId: string, filePath?: string, documentType?: 'pdf' | 'docx' | 'image', position?: Point, placement?: PanelPlacement) => string

  // Ensure the center dock zone contains a canvas panel for the given workspace.
  // Covers session-restore and new-workspace paths where the center layout may
  // exist but reference no canvas-type panel (→ blank center pane bug).
  ensureCenterCanvas: (workspaceId: string) => void

  // Panel management
  closePanel: (workspaceId: string, panelId: string) => void
  updatePanelTitle: (workspaceId: string, panelId: string, title: string) => void
  /** Apply a title that came from the running process (xterm OSC 0/1/2). Skips
   *  the update if the user has manually renamed the tab. */
  updatePanelTitleFromAgent: (workspaceId: string, panelId: string, title: string) => void
  /** User-initiated rename. Marks the panel as user-overridden so OSC updates
   *  no longer fight the chosen name. */
  renamePanelByUser: (workspaceId: string, panelId: string, title: string) => void
  updatePanelUrl: (workspaceId: string, panelId: string, url: string) => void
  /** Browser panels only: set/clear the per-panel proxy. Pass undefined to
   *  revert the panel to the shared (direct) browser session. */
  updatePanelProxy: (workspaceId: string, panelId: string, proxyUrl?: string) => void
  updatePanelFilePath: (workspaceId: string, panelId: string, filePath: string) => void
  setPanelDirty: (workspaceId: string, panelId: string, dirty: boolean) => void
  setPanelMarkdownPreview: (workspaceId: string, panelId: string, preview: boolean) => void
  setPanelUnsavedContent: (workspaceId: string, panelId: string, content: string | undefined) => void
  addPanel: (workspaceId: string, panel: PanelState) => void
  removePanelRecord: (workspaceId: string, panelId: string) => void

  // Helpers
  getWorkspace: (id: string) => WorkspaceState | undefined
  selectedWorkspace: () => WorkspaceState | undefined

  // Workspace operations
  setWorkspaceRootPath: (wsId: string, rootPath: string) => Promise<boolean>
  connectRemoteWorkspace: (wsId: string, spec: RemoteConnectSpec) => Promise<boolean>
  ensureWorkspaceCompanion: (wsId: string) => Promise<boolean>
  /** Cheap relaunch of an existing connection (companion:ensure) — for a
   *  disconnected/unreachable companion whose connection record is intact. */
  retryCompanion: (wsId: string) => Promise<boolean>
  /** Explicit clean install of the companion daemon, then connect. The entry
   *  action of the `missing` phase — the only action that installs. */
  installCompanion: (wsId: string) => Promise<boolean>
  /** Literally delete the companion: stop the daemon + rm -rf the host install
   *  (keeps saved auth). Main drives the workspace to `missing`; the user
   *  recovers via Install. */
  deleteCompanion: (wsId: string) => Promise<boolean>
  /** The single writer of a workspace's companion phase. Called ONLY by the
   *  COMPANION_STATUS broadcast — the main process is the sole authority for the
   *  phase (it probes the connection step by step). The connect/ensure/install/
   *  delete actions never set it themselves. */
  setWorkspaceCompanionPhase: (wsId: string, phase: CompanionPhase, error?: string | null) => void
  /** Set the global LOCAL companion phase (drives the local loading blocker).
   *  Written by the COMPANION_STATUS handler for LOCAL events + the init seed. */
  setLocalCompanionPhase: (phase: CompanionPhase) => void
  setWorkspaceColor: (wsId: string, color: string) => void
  renameWorkspace: (wsId: string, name: string) => void
  duplicateWorkspace: (wsId: string) => string
  closeAllPanels: (wsId: string) => void
  /** Increment a workspace's reload epoch so the main shell remounts and
   *  respawns its terminals after a from-disk layout rebuild. */
  bumpReloadEpoch: (wsId: string) => void
  /** Remove every panel currently living on one canvas (dispose terminals, drop
   *  their records, empty the canvas store) without touching the rest of the
   *  workspace. Used by layout restore to replace a single canvas's contents. */
  clearCanvas: (wsId: string, canvasPanelId: string) => void
  reorderWorkspaces: (fromIndex: number, toIndex: number) => void
  addAdditionalRoot: (wsId: string, rootPath: string) => void
  removeAdditionalRoot: (wsId: string, rootPath: string) => void

  // Parallel Work (git worktrees) — see ParallelWorkTab.tsx
  ensurePrimaryWorktree: (wsId: string) => void
  /** Seed the worktree registry from a persisted session, merging by path so a
   *  saved color/label/id wins over anything a background sync already
   *  discovered. Used on restore (see session.ts) to keep colors stable. */
  hydrateWorktrees: (wsId: string, list: WorktreeMeta[]) => void
  upsertWorktree: (wsId: string, wt: WorktreeMeta) => void
  removeWorktree: (wsId: string, worktreeId: string) => void
  setWorktreeColor: (wsId: string, worktreeId: string, color: string) => void
  setWorktreeLabel: (wsId: string, worktreeId: string, label: string | undefined) => void
  setPanelWorktreeId: (wsId: string, panelId: string, worktreeId: string | undefined) => void
  /** Re-spawn a terminal panel's PTY in a new working directory and re-tag its
   *  worktree. Disposes the live terminal and bumps `ptyEpoch` so TerminalPanel
   *  re-creates the shell rooted at `cwd`. Used by the worktree chip switcher. */
  respawnPanelTerminal: (wsId: string, panelId: string, cwd: string, worktreeId: string | undefined) => void

  // Cross-window sync: merge metadata from main-process broadcast
  mergeWorkspaceInfos: (infos: WorkspaceInfo[]) => void
}

export type AppStore = AppStoreState & AppStoreActions

export type AppSet = StoreApi<AppStore>['setState']
export type AppGet = StoreApi<AppStore>['getState']
