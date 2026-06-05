// =============================================================================
// App Store — Zustand state for workspaces and panel management.
// Workspace metadata is delegated to the main process (source of truth).
// Canvas/panel state remains local to each renderer window.
// =============================================================================

import { create } from 'zustand'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import { shallow } from 'zustand/shallow'
import log from '../lib/logger'
import type {
  WorkspaceState,
  WorkspaceInfo,
  WorkspaceMutationResult,
  PanelState,
  PanelType,
  Point,
  Size,
  DockZonePosition,
  DockStateSnapshot,
  WorktreeMeta,
  RemoteConnectSpec,
  CompanionConnection,
  CompanionPhase,
} from '../../shared/types'
import { PANEL_DEFAULT_SIZES, ZOOM_DEFAULT, ALL_ZONES } from '../../shared/types'
import { ACCENT_COLORS } from '../../shared/colors'
import type { StoreApi } from 'zustand'
import { shouldPreserveExistingCanvas } from './canvasSyncGuard'
import { terminalRegistry } from '../lib/terminal/terminalRegistry'
import { useSettingsStore } from './settingsStore'
import type { CanvasOperations } from '../lib/canvas/canvasBridge'
import { releaseCanvasStoreForPanel } from './canvasStore'
import {
  getOrCreateWorkspaceDockStore,
  getWorkspaceDockStore,
  releaseWorkspaceDockStore,
} from '../lib/workspace/dockRegistry'
import {
  ensureCanvasOpsForPanel,
  getActiveCanvasOps,
  getWorkspaceCanvasOps,
  getWorkspaceCanvasPanelId,
  getWorkspaceCanvasStore,
  setActiveCanvasPanelId,
  allCanvasOps,
  invalidateWorkspaceCanvasCache,
} from '../lib/workspace/canvasAccess'
import { setActiveSurface } from '../lib/activeSurface'
import { LOCAL_COMPANION_ID } from '../../main/companion/locator'

export type { CanvasOperations }
export {
  ensureCanvasOpsForPanel,
  getActiveCanvasOps,
  getWorkspaceCanvasPanelId,
  getWorkspaceCanvasStore,
  setActiveCanvasPanelId,
}
export {
  registerCanvasOps,
  getCanvasOpsById,
  unregisterCanvasOps,
} from '../lib/workspace/canvasAccess'

import { deferredSnapshots, restoreDeferredWorkspace } from '../lib/workspace/deferredRestore'
import { workspaceDisplayName } from '../lib/fs/displayPath'

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function generateId(): string {
  return crypto.randomUUID()
}

/** Workspace accent colors — re-exported from the shared accent palette. */
export const WORKSPACE_COLORS = ACCENT_COLORS

function createDefaultWorkspace(
  name?: string,
  rootPath?: string,
  id?: string,
  connection?: CompanionConnection,
): WorkspaceState {
  return {
    id: id ?? generateId(),
    name: name ?? 'Workspace',
    color: '',
    rootPath: rootPath ?? '',
    // Carry remote reconnect info through restore so ensureWorkspaceCompanion
    // can reconnect the companion before any fs/git/terminal op (Finding 2).
    ...(connection && connection.kind !== 'local' ? { connection } : {}),
    rootPathError: null,
    isRootPathPending: false,
    panels: {},
    canvasNodes: {},
    regions: {},
    zoomLevel: ZOOM_DEFAULT,
    viewportOffset: { x: 0, y: 0 },
    focusedNodeId: null,
  }
}

// -----------------------------------------------------------------------------
// Main-process sync helpers (fire-and-forget — local state is optimistic)
// -----------------------------------------------------------------------------

// Serialize workspace mutations so main-process state can't diverge from
// renderer state when multiple updates fire in quick succession (the previous
// fire-and-forget approach allowed them to land out of order).
let workspaceSyncQueue: Promise<unknown> = Promise.resolve()
function enqueueWorkspaceSync<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  workspaceSyncQueue = workspaceSyncQueue
    .then(fn, fn)
    .catch((err) => log.warn(`[workspace-sync] ${label} failed:`, err))
  const resultPromise = workspaceSyncQueue as Promise<T | undefined>
  return resultPromise
}

// Callers that need to invoke main-process IPC depending on a workspace's
// rootPath (e.g. terminal:create with cwd=rootPath) must await this first.
// Otherwise the IPC can race a pending workspace:create / workspace:update and
// fail validation with "outside allowed directories" because the new root
// hasn't been registered in allowedRoots yet.
export function awaitWorkspaceSync(): Promise<void> {
  return workspaceSyncQueue.then(() => undefined, () => undefined)
}

function applyWorkspaceInfo(ws: WorkspaceState, info: WorkspaceInfo): WorkspaceState {
  return {
    ...ws,
    id: info.id,
    name: info.name,
    color: info.color,
    rootPath: info.rootPath,
    connection: info.connection ?? ws.connection,
    rootPathError: null,
    isRootPathPending: false,
  }
}

function syncCreateToMain(ws: WorkspaceState): Promise<WorkspaceMutationResult | undefined> {
  return enqueueWorkspaceSync('Create', () =>
    window.electronAPI.workspaceCreate({
      name: ws.name,
      rootPath: ws.rootPath,
      id: ws.id,
      // Pass remote reconnect info so WorkspaceInfo.connection survives on the
      // main side (Finding 2) — main skips local realpath/lock for a locator.
      ...(ws.connection && ws.connection.kind !== 'local' ? { connection: ws.connection } : {}),
    }),
  )
}

function syncUpdateToMain(id: string, changes: Partial<Omit<WorkspaceInfo, 'id'>>): Promise<WorkspaceMutationResult | undefined> {
  return enqueueWorkspaceSync('Update', () => window.electronAPI.workspaceUpdate(id, changes))
}

function syncRemoveFromMain(id: string): void {
  enqueueWorkspaceSync('Remove', () => window.electronAPI.workspaceRemove(id))
}

// -----------------------------------------------------------------------------
// Panel placement — specifies where a newly created panel should go
// -----------------------------------------------------------------------------

export type PanelPlacement =
  /** `canvasPanelId` pins the create to a SPECIFIC canvas (the one the toolbar /
   *  right-click menu / drop originated from). Without it, placement routes to
   *  the workspace's primary canvas — correct for session restore and auto
   *  creates, but wrong for an interactive create on a secondary/nested canvas. */
  | { target: 'canvas'; position?: Point; canvasPanelId?: string }
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
// Worktree colors — fixed palette assigned round-robin to new worktrees.
// Picked to be visually distinct in both light and dark themes.
// -----------------------------------------------------------------------------

export const WORKTREE_COLOR_PALETTE: string[] = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ec4899', // pink
  '#8b5cf6', // violet
  '#14b8a6', // teal
  '#ef4444', // red
  '#84cc16', // lime
  '#06b6d4', // cyan
  '#f97316', // orange
]

export function pickWorktreeColor(existing: { color: string }[]): string {
  const used = new Set(existing.map((w) => w.color))
  for (const c of WORKTREE_COLOR_PALETTE) if (!used.has(c)) return c
  // Wrap around if more worktrees than palette entries.
  return WORKTREE_COLOR_PALETTE[existing.length % WORKTREE_COLOR_PALETTE.length]
}

/** A fully-reset dock layout: all side zones hidden, an empty visible center.
 *  Used whenever we need to clear a workspace's dock so panels from a previous
 *  workspace can't bleed through (workspace switch, removal, closeAllPanels). */
function createCleanDockSnapshot(): DockStateSnapshot {
  return {
    zones: {
      left: { position: 'left', visible: false, size: 260, layout: null },
      right: { position: 'right', visible: false, size: 260, layout: null },
      bottom: { position: 'bottom', visible: false, size: 240, layout: null },
      center: { position: 'center', visible: true, size: 0, layout: null },
    },
    locations: {},
  }
}

// -----------------------------------------------------------------------------
// Store interface
// -----------------------------------------------------------------------------

interface AppStoreState {
  workspaces: WorkspaceState[]
  selectedWorkspaceId: string
  /** Phase of the built-in LOCAL companion daemon (a process-wide singleton, so
   *  it's global rather than per-workspace). Drives the local loading blocker.
   *  `null` until seeded at init. */
  localCompanionPhase: CompanionPhase | null
}

interface AppStoreActions {
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

  // Helpers
  getWorkspace: (id: string) => WorkspaceState | undefined
  selectedWorkspace: () => WorkspaceState | undefined

  // Sync canvas state snapshot back into workspace (call before switching)
  syncCanvasToWorkspace: (workspaceId: string) => void

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
  reorderWorkspaces: (fromIndex: number, toIndex: number) => void
  addAdditionalRoot: (wsId: string, rootPath: string) => void
  removeAdditionalRoot: (wsId: string, rootPath: string) => void

  // Parallel Work (git worktrees) — see ParallelWorkTab.tsx
  ensurePrimaryWorktree: (wsId: string) => void
  upsertWorktree: (wsId: string, wt: WorktreeMeta) => void
  removeWorktree: (wsId: string, worktreeId: string) => void
  setWorktreeColor: (wsId: string, worktreeId: string, color: string) => void
  setWorktreeLabel: (wsId: string, worktreeId: string, label: string | undefined) => void
  setPanelWorktreeId: (wsId: string, panelId: string, worktreeId: string | undefined) => void

  // Cross-window sync: merge metadata from main-process broadcast
  mergeWorkspaceInfos: (infos: WorkspaceInfo[]) => void
}

export type AppStore = AppStoreState & AppStoreActions

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

/** Place a panel into its workspace's dock or canvas. Routes by the workspace's
 *  own stores so it works for the active workspace AND for a background restore
 *  into an inactive one — never touching another workspace's layout. */
function placePanel(
  workspaceId: string,
  panelId: string,
  panelType: PanelType,
  placement: PanelPlacement | undefined,
  position: Point | undefined,
  isActiveWorkspace: boolean,
  onGhostCancel?: (panelId: string) => void,
): void {
  // No-op: caller is placing the panel itself into a private DockStore.
  if (placement?.target === 'none') return
  const dockStore = getOrCreateWorkspaceDockStore(workspaceId)
  // Canvas panels go to the center dock zone, not onto a canvas as a node
  if (panelType === 'canvas') {
    dockStore.getState().dockPanel(panelId, 'center')
    return
  }
  if (placement?.target === 'dock') {
    // stackId → drop as a tab in that exact stack (the focused split pane);
    // otherwise zone-level. dockPanel falls back to the zone if the stack is gone.
    dockStore.getState().dockPanel(
      panelId,
      placement.zone,
      placement.stackId ? { type: 'tab', stackId: placement.stackId } : undefined,
    )
    return
  }
  // Default: place on a canvas (target === 'canvas'/'auto'/undefined).
  // Prefer the explicit originating canvas when the caller pinned one (an
  // interactive create from a specific canvas's toolbar/menu/drop), so the node
  // lands on the canvas the user aimed at — not just the primary one. Otherwise
  // route by workspace id, which lands on the workspace's own primary canvas and
  // works for a background restore into an inactive workspace.
  const pinnedCanvasId = placement?.target === 'canvas' ? placement.canvasPanelId : undefined
  const ops = pinnedCanvasId ? ensureCanvasOpsForPanel(pinnedCanvasId) : getWorkspaceCanvasOps(workspaceId)
  if (!ops) return
  const canvasPosition = placement?.target === 'canvas' ? placement.position ?? position : position
  // Ambiguous create (no explicit position) on the active workspace: when the
  // recommendation picker is enabled, show ghost candidates and let the user
  // choose where the node lands (deferred until commit; onGhostCancel rolls the
  // panel back). When the setting is off — or for a background restore — fall
  // through and auto-place in the best spot. Explicit-position paths (drag-drop,
  // session restore, right-click "new here") always skip the picker.
  if (isActiveWorkspace && canvasPosition == null && onGhostCancel && useSettingsStore.getState().placementPicker) {
    const shown = ops.beginPlacement(panelId, panelType, onGhostCancel)
    if (shown) return
  }
  ops.addNodeAndFocus(panelId, panelType, canvasPosition)
}

type AppSet = StoreApi<AppStore>['setState']
type AppGet = StoreApi<AppStore>['getState']

/** Add a freshly-built panel to a workspace, then route it to its canvas/dock
 *  location. On placement failure the panel is rolled back out of the workspace
 *  so no orphaned entry lingers. Shared by every create* action. */
function addAndPlacePanel(
  set: AppSet,
  get: AppGet,
  workspaceId: string,
  panel: PanelState,
  placement: PanelPlacement | undefined,
  position: Point | undefined,
): string {
  set((state) => ({
    workspaces: state.workspaces.map((ws) =>
      ws.id === workspaceId
        ? { ...ws, panels: { ...ws.panels, [panel.id]: panel } }
        : ws,
    ),
  }))
  // Roll the panel record back out of the workspace — used both on a placement
  // error and when an interactive ghost placement is cancelled (no orphan left).
  const discardPanel = () => {
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.id === workspaceId
          ? { ...ws, panels: Object.fromEntries(
              Object.entries(ws.panels).filter(([id]) => id !== panel.id)
            )}
          : ws,
      ),
    }))
  }
  try {
    placePanel(workspaceId, panel.id, panel.type, placement, position, workspaceId === get().selectedWorkspaceId, discardPanel)
  } catch (error) {
    discardPanel()
    log.error(`Failed to place ${panel.type} panel:`, error)
    return null as unknown as string
  }
  return panel.id
}

/** Apply an update to a single panel within a workspace. No-ops if the
 *  workspace or panel is missing, or if `update` returns the same panel
 *  reference (lets callers bail out without mutating). Shared by every
 *  panel-field setter. */
function setPanelField(
  set: AppSet,
  workspaceId: string,
  panelId: string,
  update: (panel: PanelState) => PanelState,
): void {
  set((state) => ({
    workspaces: state.workspaces.map((ws) => {
      if (ws.id !== workspaceId) return ws
      const panel = ws.panels[panelId]
      if (!panel) return ws
      const next = update(panel)
      if (next === panel) return ws
      return { ...ws, panels: { ...ws.panels, [panelId]: next } }
    }),
  }))
}

export const useAppStore = create<AppStore>((set, get) => ({
  // --- State ---
  // Start empty — a default workspace is created during init only if no session is restored.
  workspaces: [],
  selectedWorkspaceId: '',
  localCompanionPhase: null,

  // --- Workspace management ---

  addWorkspace(name?, rootPath?, id?, connection?) {
    // Reusing a stable id (session restore) must not be blocked by the cap and
    // must never create a second entry for an id that already exists — both
    // would resurrect the "duplicate workspaces on reload" bug.
    if (id) {
      const existing = get().workspaces.find((w) => w.id === id)
      if (existing) return existing.id
    }
    const existingCount = get().workspaces.length
    if (!id && existingCount >= 10) {
      // Cap at 10 workspaces — no-op, return current selection
      return get().selectedWorkspaceId || get().workspaces[0]?.id || ''
    }
    const ws = createDefaultWorkspace(name, rootPath, id, connection)

    // Note: the new workspace starts with an empty panels map and its own (empty)
    // dock + canvas stores. ensureCenterCanvas mints a fresh canvas panel for the
    // center zone when the workspace is shown. Copying panels from another
    // workspace here led to orphaned/duplicate canvas panels and the "empty pane"
    // bug.

    set((state) => ({
      workspaces: [...state.workspaces, ws],
      // Auto-select if this is the first workspace
      selectedWorkspaceId: state.workspaces.length === 0 ? ws.id : state.selectedWorkspaceId,
    }))
    // Sync to main process
    syncCreateToMain(ws).then((result) => {
      if (!result?.ok) {
        log.warn('[workspace-sync] Create rejected:', result?.error?.message)
        return
      }
      set((state) => ({
        workspaces: state.workspaces.map((candidate) => (
          candidate.id === ws.id ? applyWorkspaceInfo(candidate, result.workspace) : candidate
        )),
      }))
    })
    return ws.id
  },

  async selectWorkspace(id) {
    const state = get()
    if (state.selectedWorkspaceId === id) {
      // Already selected — normally a no-op. But addWorkspace auto-selects the
      // first workspace on restore, so the restore's selectWorkspace(firstId)
      // would otherwise skip the companion connect entirely, leaving a remote
      // workspace stuck with no phase (a permanent "connecting" lock) and every
      // companion op failing with "No companion registered". Kick off the
      // connect here so the restore's awaited selectWorkspace still resolves
      // only once the companion is live.
      const current = state.workspaces.find((w) => w.id === id)
      if (current?.connection && current.connection.kind !== 'local' && !current.companion) {
        await get().ensureWorkspaceCompanion(id)
      }
      return
    }

    // Snapshot the outgoing workspace's live stores back into its persisted
    // fields so it round-trips through save/restore. Each workspace owns its
    // dock + canvas stores, so nothing is ever copied between workspaces.
    get().syncCanvasToWorkspace(state.selectedWorkspaceId)

    // Discard outgoing workspace if it was never initialized (no folder
    // picked, not currently picking one). Keeps stray "Add Workspace" rows
    // from accumulating in the sidebar.
    const outgoing = state.workspaces.find((w) => w.id === state.selectedWorkspaceId)
    const shouldDropOutgoing =
      !!outgoing && !outgoing.rootPath && !outgoing.isRootPathPending && outgoing.id !== id

    // Switch selection. The shell is keyed by selectedWorkspaceId, so it
    // remounts and reads the incoming workspace's OWN dock + canvas stores —
    // there is no shared store to overwrite, so content cannot bleed across
    // workspaces even if a restore is still in flight.
    set({ selectedWorkspaceId: id })
    const incomingCanvasPanelId = getWorkspaceCanvasPanelId(id)
    if (incomingCanvasPanelId) {
      setActiveCanvasPanelId(incomingCanvasPanelId)
      // Reset the keyboard-create target to the incoming canvas so a stack the
      // user last touched in the OTHER workspace can't attract new panels here.
      setActiveSurface({ kind: 'canvas', canvasPanelId: incomingCanvasPanelId })
    }

    // Reconnect a remote workspace's companion if it isn't live (e.g. after a
    // restart / restore). For a REMOTE workspace we must AWAIT this before the
    // deferred restore below, because that creates terminals and reads files
    // that route through the companion — racing the async reconnect would hit
    // an unregistered companion and throw. Local workspaces stay synchronous.
    const incoming = get().workspaces.find((w) => w.id === id)
    if (incoming?.connection && incoming.connection.kind !== 'local') {
      const ok = await get().ensureWorkspaceCompanion(id)
      if (!ok) {
        log.warn('[companion] reconnect failed for workspace %s; restore will surface the error', id)
      }
    }

    if (shouldDropOutgoing && outgoing) {
      get().removeWorkspace(outgoing.id)
    }

    // First activation of a workspace restored from disk: replay its snapshot
    // into its own stores. restoreDeferredWorkspace addresses the workspace by
    // id, so a concurrent switch can never redirect it into another workspace.
    if (deferredSnapshots.has(id)) {
      try {
        await restoreDeferredWorkspace(id)
      } catch (error) {
        log.error('Failed to restore deferred workspace:', error)
      }
    }

    // Guarantee the center zone has a canvas panel — a brand new workspace, or
    // a restored dock layout that referenced no canvas-type panel.
    if (get().workspaces.some((w) => w.id === id)) {
      get().ensureCenterCanvas(id)
    }
  },

  ensureCenterCanvas(workspaceId) {
    const ws = get().workspaces.find((w) => w.id === workspaceId)
    if (!ws) return
    const dockStore = getOrCreateWorkspaceDockStore(workspaceId)
    const dockState = dockStore.getState()

    // Collect panel IDs referenced by any dock zone
    const walk = (
      node: import('../../shared/types').DockLayoutNode,
      out: Set<string>,
    ) => {
      if (node.type === 'tabs') node.panelIds.forEach((id) => out.add(id))
      else node.children.forEach((c) => walk(c, out))
    }
    const allDockPanelIds = new Set<string>()
    for (const zoneName of ALL_ZONES) {
      const zone = dockState.zones[zoneName]
      if (zone.layout) walk(zone.layout, allDockPanelIds)
    }

    // Sweep orphaned canvas panels (in ws.panels but not in any dock zone).
    // These accumulate when session restore or dock resets leave stale
    // canvas entries behind — the sidebar would then show phantom canvases.
    const orphanedCanvasIds = Object.values(ws.panels)
      .filter((p) => p.type === 'canvas' && !allDockPanelIds.has(p.id))
      .map((p) => p.id)

    if (orphanedCanvasIds.length > 0) {
      for (const id of orphanedCanvasIds) {
        try { releaseCanvasStoreForPanel(id) } catch { /* ignore */ }
      }
      set((state) => ({
        workspaces: state.workspaces.map((w) => {
          if (w.id !== workspaceId) return w
          const panels = { ...w.panels }
          for (const id of orphanedCanvasIds) delete panels[id]
          return { ...w, panels }
        }),
      }))
    }

    // Sweep orphaned dock tabs (in some dock zone but not in ws.panels). These
    // appear after a panel state was dropped without the dock layout being
    // updated — e.g. closeAllPanels wiping ws.panels, or a stale snapshot
    // restore — and render as a generic "Panel" tab with the editor icon.
    const orphanedDockIds = Array.from(allDockPanelIds).filter((id) => !ws.panels[id])
    if (orphanedDockIds.length > 0) {
      for (const id of orphanedDockIds) {
        try { dockStore.getState().undockPanel(id) } catch { /* ignore */ }
      }
    }

    // Check if the center zone now contains a canvas-type panel
    const centerPanelIds: string[] = []
    const center = dockStore.getState().zones.center
    if (center.layout) {
      const c = new Set<string>()
      walk(center.layout, c)
      centerPanelIds.push(...c)
    }
    const wsAfter = get().workspaces.find((w) => w.id === workspaceId)
    const hasCanvas = centerPanelIds.some((pid) => wsAfter?.panels[pid]?.type === 'canvas')
    if (!hasCanvas) {
      get().createCanvas(workspaceId)
    }
  },

  removeWorkspace(id, forgetRecent = false) {
    // When the user explicitly closes a workspace, also forget its project so it
    // doesn't reappear on next launch (issue #220). Opt-in: the default keeps
    // recents intact for non-user removals (session-restore teardown, dropping
    // an uninitialized stray workspace). Capture the rootPath before we mutate.
    if (forgetRecent) {
      const closing = get().workspaces.find((w) => w.id === id)
      if (closing?.rootPath) {
        window.electronAPI.recentProjectsRemove(closing.rootPath).catch((err) =>
          log.warn('[workspace] Failed to remove from recent projects:', err),
        )
      }
    }
    // Clean up deferred snapshot if workspace was never switched to
    deferredSnapshots.delete(id)
    // Dispose terminals + clear the workspace's stores before removing it.
    get().closeAllPanels(id)
    // Drop the workspace's isolated stores so they can't linger or be reused.
    // Read the canvas panels AFTER closeAllPanels (it mints a fresh center
    // canvas) so the minted store is released too.
    for (const panel of Object.values(get().workspaces.find((w) => w.id === id)?.panels ?? {})) {
      if (panel.type === 'canvas') {
        try { releaseCanvasStoreForPanel(panel.id) } catch { /* ignore */ }
      }
    }
    releaseWorkspaceDockStore(id)
    invalidateWorkspaceCanvasCache(id)
    terminalRegistry.disposeWorkspace(id)

    const wasSelected = get().selectedWorkspaceId === id

    set((state) => {
      const remaining = state.workspaces.filter((w) => w.id !== id)
      if (remaining.length === 0) {
        // Always keep at least one workspace
        const fresh = createDefaultWorkspace()
        syncCreateToMain(fresh)
        return {
          workspaces: [fresh],
          selectedWorkspaceId: fresh.id,
        }
      }
      const newSelected =
        state.selectedWorkspaceId === id ? remaining[0].id : state.selectedWorkspaceId
      return {
        workspaces: remaining,
        selectedWorkspaceId: newSelected,
      }
    })

    // If the removed workspace was selected, the shell remounts onto the new
    // selection and reads ITS own stores — nothing to copy. Just make sure the
    // newly-selected workspace's center zone has a canvas panel.
    if (wasSelected) {
      const newId = get().selectedWorkspaceId
      if (get().workspaces.some((w) => w.id === newId)) {
        get().ensureCenterCanvas(newId)
      }
    }

    // Sync to main process
    syncRemoveFromMain(id)
  },

  // --- Panel creation ---

  createTerminal(workspaceId, initialInput?, position?, placement?, cwd?) {
    const panelId = generateId()
    // Auto-number terminal titles within the workspace so `cate ask "Terminal 2"`
    // and similar inter-panel calls can address each one unambiguously. Looks
    // for the highest existing "Terminal N" name and picks N+1.
    const ws = get().workspaces.find((w) => w.id === workspaceId)
    let maxN = 0
    if (ws) {
      for (const p of Object.values(ws.panels)) {
        if (p.type !== 'terminal') continue
        const m = /^Terminal\s+(\d+)$/.exec(p.title)
        if (m) {
          const n = parseInt(m[1], 10)
          if (n > maxN) maxN = n
        }
      }
    }
    const panel: PanelState = {
      id: panelId,
      type: 'terminal',
      title: `Terminal ${maxN + 1}`,
      isDirty: false,
      ...(cwd ? { cwd } : {}),
    }
    return addAndPlacePanel(set, get, workspaceId, panel, placement, position)
  },

  createBrowser(workspaceId, url?, position?, placement?, proxyUrl?) {
    const panelId = generateId()
    const panel: PanelState = {
      id: panelId,
      type: 'browser',
      title: url ?? 'Browser',
      isDirty: false,
      url: url ?? 'about:blank',
      ...(proxyUrl ? { proxyUrl } : {}),
    }
    return addAndPlacePanel(set, get, workspaceId, panel, placement, position)
  },

  createEditor(workspaceId, filePath?, position?, placement?) {
    const panelId = generateId()
    const fileName = filePath ? filePath.split('/').pop() ?? 'Untitled' : 'Untitled'
    const panel: PanelState = {
      id: panelId,
      type: 'editor',
      title: fileName,
      isDirty: false,
      filePath,
    }
    return addAndPlacePanel(set, get, workspaceId, panel, placement, position)
  },

  createDocument(workspaceId, filePath?, documentType?, position?, placement?) {
    const panelId = generateId()
    const fileName = filePath ? filePath.split('/').pop() ?? 'Document' : 'Document'
    const panel: PanelState = {
      id: panelId,
      type: 'document',
      title: fileName,
      isDirty: false,
      filePath,
      documentType,
    }
    return addAndPlacePanel(set, get, workspaceId, panel, placement, position)
  },

  createDiffEditor(workspaceId, filePath, diffMode, position?, placement?) {
    const panelId = generateId()
    const fileName = filePath.split('/').pop() ?? 'Untitled'
    const label = diffMode === 'staged' ? 'Staged' : 'Working'
    const panel: PanelState = {
      id: panelId,
      type: 'editor',
      title: `${fileName} (${label} Diff)`,
      isDirty: false,
      filePath,
      diffMode,
    }
    return addAndPlacePanel(set, get, workspaceId, panel, placement, position)
  },

  createCanvas(workspaceId, position?, placement?) {
    const panel: PanelState = {
      id: generateId(),
      type: 'canvas',
      title: 'Canvas',
      isDirty: false,
    }
    return addAndPlacePanel(set, get, workspaceId, panel, placement, position)
  },

  createAgent(workspaceId, position?, placement?) {
    const panel: PanelState = {
      id: generateId(),
      type: 'agent',
      title: 'Agent',
      isDirty: false,
    }
    return addAndPlacePanel(set, get, workspaceId, panel, placement, position)
  },

  // --- Panel management ---

  closePanel(workspaceId, panelId) {
    // Dispose terminal before removing the panel
    const ws = get().workspaces.find((w) => w.id === workspaceId)
    const panel = ws?.panels[panelId]
    if (panel?.type === 'terminal') {
      terminalRegistry.dispose(panelId)
    }
    if (panel?.type === 'canvas') {
      releaseCanvasStoreForPanel(panelId)
    }

    // Remove from dock/canvas first (less critical — log errors but continue)
    const dockStore = getOrCreateWorkspaceDockStore(workspaceId)
    try {
      const dockLocation = dockStore.getState().panelLocations[panelId]
      if (dockLocation?.type === 'dock') {
        dockStore.getState().undockPanel(panelId)
      } else {
        // Try all registered canvas stores (panel could be on any canvas,
        // including a nested one). Workspace-agnostic: removes wherever found.
        for (const ops of allCanvasOps()) {
          const nodeId = ops.storeApi.getState().nodeForPanel(panelId)
          if (nodeId) {
            ops.removeNodeForPanel(panelId)
            break
          }
        }
      }
    } catch (error) {
      log.error('Failed to remove panel from dock/canvas during close:', error)
    }

    // Clean up location tracking
    try {
      dockStore.getState().removePanelLocation(panelId)
    } catch (error) {
      log.error('Failed to clean up panel location tracking:', error)
    }

    // Remove from workspace panels (always do this to ensure cleanup)
    set((state) => ({
      workspaces: state.workspaces.map((ws) => {
        if (ws.id !== workspaceId) return ws
        const { [panelId]: _removed, ...remainingPanels } = ws.panels
        return { ...ws, panels: remainingPanels }
      }),
    }))
  },

  updatePanelTitle(workspaceId, panelId, title) {
    setPanelField(set, workspaceId, panelId, (panel) => ({ ...panel, title }))
  },

  updatePanelTitleFromAgent(workspaceId, panelId, title) {
    setPanelField(set, workspaceId, panelId, (panel) => (
      panel.titleUserOverridden || panel.title === title
        ? panel
        : { ...panel, title }
    ))
  },

  renamePanelByUser(workspaceId, panelId, title) {
    setPanelField(set, workspaceId, panelId, (panel) => ({ ...panel, title, titleUserOverridden: true }))
  },

  updatePanelUrl(workspaceId, panelId, url) {
    setPanelField(set, workspaceId, panelId, (panel) => ({ ...panel, url }))
  },

  updatePanelProxy(workspaceId, panelId, proxyUrl) {
    setPanelField(set, workspaceId, panelId, (panel) => ({ ...panel, proxyUrl: proxyUrl || undefined }))
  },

  updatePanelFilePath(workspaceId, panelId, filePath) {
    setPanelField(set, workspaceId, panelId, (panel) => ({ ...panel, filePath }))
  },

  setPanelDirty(workspaceId, panelId, dirty) {
    setPanelField(set, workspaceId, panelId, (panel) => ({ ...panel, isDirty: dirty }))
  },

  setPanelMarkdownPreview(workspaceId, panelId, preview) {
    set((state) => ({
      workspaces: state.workspaces.map((ws) => {
        if (ws.id !== workspaceId) return ws
        const panel = ws.panels[panelId]
        if (!panel) return ws
        return {
          ...ws,
          panels: { ...ws.panels, [panelId]: { ...panel, markdownPreview: preview } },
        }
      }),
    }))
  },

  setPanelUnsavedContent(workspaceId, panelId, content) {
    setPanelField(set, workspaceId, panelId, (panel) => ({ ...panel, unsavedContent: content }))
  },

  addPanel(workspaceId, panel) {
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.id === workspaceId
          ? { ...ws, panels: { ...ws.panels, [panel.id]: panel } }
          : ws,
      ),
    }))
  },

  // --- Helpers ---

  getWorkspace(id) {
    return get().workspaces.find((w) => w.id === id)
  },

  selectedWorkspace() {
    return get().workspaces.find((w) => w.id === get().selectedWorkspaceId)
  },

  syncCanvasToWorkspace(workspaceId) {
    const canvasStore = getWorkspaceCanvasStore(workspaceId)
    const canvasState = canvasStore?.getState()
    if (!canvasState) return

    // Also snapshot this workspace's OWN dock state so it's saved per workspace.
    const liveDock = getWorkspaceDockStore(workspaceId)
    const dockSnapshot = liveDock?.getState().getSnapshot()

    set((state) => ({
      workspaces: state.workspaces.map((ws) => {
        if (ws.id !== workspaceId) return ws
        if (shouldPreserveExistingCanvas(
          Object.keys(canvasState.nodes).length,
          Object.keys(ws.canvasNodes ?? {}).length,
        )) {
          // Keep nodes/regions/viewport intact; only refresh dock state.
          return { ...ws, dockState: dockSnapshot ?? ws.dockState }
        }
        return {
          ...ws,
          canvasNodes: { ...canvasState.nodes },
          regions: { ...canvasState.regions },
          viewportOffset: { ...canvasState.viewportOffset },
          zoomLevel: canvasState.zoomLevel,
          focusedNodeId: canvasState.focusedNodeId,
          dockState: dockSnapshot ?? ws.dockState,
        }
      }),
    }))
  },

  setWorkspaceRootPath(wsId, rootPath) {
    const ws = get().workspaces.find((w) => w.id === wsId)
    if (!ws) return Promise.resolve(false)
    const folderName = workspaceDisplayName(rootPath) || rootPath
    const desiredName = ws.name === 'Workspace' ? folderName : ws.name
    // Apply optimistically so any panel created synchronously after this call
    // (e.g. WelcomePage spawning a terminal right after picking a folder)
    // sees the new rootPath and uses it as cwd instead of falling back to $HOME.
    set((state) => ({
      workspaces: state.workspaces.map((candidate) => {
        if (candidate.id !== wsId) return candidate
        return {
          ...candidate,
          rootPath,
          name: desiredName,
          isRootPathPending: true,
          rootPathError: null,
        }
      }),
    }))
    return syncUpdateToMain(wsId, { rootPath, name: desiredName }).then((result) => {
      if (!result?.ok) {
        const message = result?.error?.message ?? 'Failed to update workspace root'
        set((state) => ({
          workspaces: state.workspaces.map((candidate) => (
            candidate.id === wsId
              ? { ...candidate, isRootPathPending: false, rootPathError: message }
              : candidate
          )),
        }))
        log.warn('[workspace-sync] Update rejected:', message)
        return false
      }
      set((state) => ({
        workspaces: state.workspaces.map((candidate) => (
          candidate.id === wsId
            ? applyWorkspaceInfo(candidate, result.workspace)
            : candidate
        )),
      }))
      window.electronAPI.recentProjectsAdd(result.workspace.rootPath)
      return true
    })
  },

  setWorkspaceCompanionPhase(wsId, phase, error) {
    set((state) => ({
      workspaces: state.workspaces.map((c) =>
        c.id === wsId ? { ...c, companion: { phase, ...(error != null ? { error } : {}) } } : c,
      ),
    }))
  },

  setLocalCompanionPhase(phase) {
    set({ localCompanionPhase: phase })
  },

  async connectRemoteWorkspace(wsId, spec) {
    const ws = get().workspaces.find((w) => w.id === wsId)
    if (!ws) return false
    let res
    try {
      res = await window.electronAPI.companionConnect(spec)
    } catch (err) {
      log.warn('[companion] connect failed:', err instanceof Error ? err.message : String(err))
      return false
    }
    if (!res?.ok) {
      log.warn('[companion] connect failed:', res?.error ?? 'unknown')
      return false
    }

    const label = spec.kind === 'wsl' ? `${spec.distro}` : `${spec.user}@${spec.host}`
    const desiredName = ws.name === 'Workspace' ? label : ws.name
    // Store rootPath + connection FIRST so the probe's COMPANION_STATUS phases
    // (keyed by companionId) can match this workspace.
    set((state) => ({
      workspaces: state.workspaces.map((c) =>
        c.id === wsId ? { ...c, rootPath: res!.rootPath, name: desiredName } : c,
      ),
    }))
    const result = await syncUpdateToMain(wsId, {
      rootPath: res.rootPath,
      name: desiredName,
      connection: res.connection,
    })
    if (!result?.ok) {
      log.warn('[companion] register failed:', result?.error?.message ?? 'unknown')
      return false
    }
    set((state) => ({
      workspaces: state.workspaces.map((c) => (c.id === wsId ? applyWorkspaceInfo(c, result.workspace) : c)),
    }))
    // Probe to drive the phase. Main reports connected / missing / unreachable;
    // we never set the phase ourselves. (A fresh remote with no daemon lands in
    // 'missing' → the canvas lock offers Install.)
    await get().ensureWorkspaceCompanion(wsId)
    return true
  },

  async ensureWorkspaceCompanion(wsId) {
    const ws = get().workspaces.find((w) => w.id === wsId)
    if (!ws?.connection || ws.connection.kind === 'local') return true
    // Probe only. The phase (connecting → connected | missing | unreachable) is
    // emitted by the main process and lands via the COMPANION_STATUS broadcast.
    // No client-side phase logic. Returns whether the companion is now live.
    try {
      const res = await window.electronAPI.companionEnsure(ws.connection)
      return !!res?.ok
    } catch (err) {
      log.warn('[companion] ensure failed:', err instanceof Error ? err.message : String(err))
      return false
    }
  },

  // The lock overlay's "Retry"/"Reconnect" — re-probe the existing connection.
  async retryCompanion(wsId) {
    return get().ensureWorkspaceCompanion(wsId)
  },

  async installCompanion(wsId) {
    const ws = get().workspaces.find((w) => w.id === wsId)
    if (!ws?.connection || ws.connection.kind === 'local') return false
    try {
      const res = await window.electronAPI.companionInstall(ws.connection)
      return !!res?.ok
    } catch (err) {
      log.warn('[companion] install failed:', err instanceof Error ? err.message : String(err))
      return false
    }
  },

  async deleteCompanion(wsId) {
    const ws = get().workspaces.find((w) => w.id === wsId)
    if (!ws?.connection || ws.connection.kind === 'local') return false
    try {
      // Main rm -rf's the host install and drives the phase to 'missing'.
      const res = await window.electronAPI.companionDelete(ws.connection)
      return !!res?.ok
    } catch (err) {
      log.warn('[companion] delete failed:', err instanceof Error ? err.message : String(err))
      return false
    }
  },

  setWorkspaceColor(wsId, color) {
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.id === wsId ? { ...ws, color } : ws,
      ),
    }))
    syncUpdateToMain(wsId, { color })
  },

  renameWorkspace(wsId, name) {
    const trimmed = name.trim()
    if (!trimmed) return
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.id === wsId ? { ...ws, name: trimmed } : ws,
      ),
    }))
    syncUpdateToMain(wsId, { name: trimmed })
  },

  duplicateWorkspace(wsId) {
    const ws = get().workspaces.find((w) => w.id === wsId)
    if (!ws) return wsId
    const copy: WorkspaceState = {
      id: generateId(),
      name: `${ws.name} Copy`,
      color: ws.color,
      rootPath: ws.rootPath,
      panels: {},
      canvasNodes: {},
      regions: {},
      zoomLevel: ZOOM_DEFAULT,
      viewportOffset: { x: 0, y: 0 },
      focusedNodeId: null,
    }
    set((state) => ({ workspaces: [...state.workspaces, copy] }))
    syncCreateToMain(copy)
    return copy.id
  },

  reorderWorkspaces(fromIndex, toIndex) {
    // `toIndex` is an insertion slot in [0, length]: 0 = before the first row,
    // length = after the last. Dropping at the item's own slot or the one just
    // after it leaves the order unchanged.
    set((state) => {
      if (toIndex === fromIndex || toIndex === fromIndex + 1) return state
      const workspaces = [...state.workspaces]
      const [moved] = workspaces.splice(fromIndex, 1)
      // Removing the dragged item first shifts every later slot down by one, so
      // for downward moves the insertion slot is one less than requested.
      const insertAt = fromIndex < toIndex ? toIndex - 1 : toIndex
      workspaces.splice(insertAt, 0, moved)
      return { workspaces }
    })
  },

  addAdditionalRoot(wsId, rootPath) {
    set((state) => ({
      workspaces: state.workspaces.map((ws) => {
        if (ws.id !== wsId) return ws
        const current = ws.additionalRoots ?? []
        // Don't add duplicates or the primary root itself.
        if (rootPath === ws.rootPath || current.includes(rootPath)) return ws
        return { ...ws, additionalRoots: [...current, rootPath] }
      }),
    }))
  },

  removeAdditionalRoot(wsId, rootPath) {
    set((state) => ({
      workspaces: state.workspaces.map((ws) => {
        if (ws.id !== wsId) return ws
        const current = ws.additionalRoots ?? []
        return { ...ws, additionalRoots: current.filter((p) => p !== rootPath) }
      }),
    }))
  },

  // --- Parallel Work (git worktrees) ---

  ensurePrimaryWorktree(wsId) {
    set((state) => ({
      workspaces: state.workspaces.map((ws) => {
        if (ws.id !== wsId) return ws
        const list = ws.worktrees ?? []
        if (list.some((w) => w.isPrimary)) return ws
        if (!ws.rootPath) return ws
        const primary: WorktreeMeta = {
          id: `wt-primary-${ws.id}`,
          path: ws.rootPath,
          branch: '',
          color: pickWorktreeColor(list),
          isPrimary: true,
        }
        return { ...ws, worktrees: [primary, ...list] }
      }),
    }))
  },

  upsertWorktree(wsId, wt) {
    set((state) => ({
      workspaces: state.workspaces.map((ws) => {
        if (ws.id !== wsId) return ws
        const list = ws.worktrees ?? []
        const idx = list.findIndex((w) => w.id === wt.id)
        const next = idx >= 0
          ? list.map((w) => (w.id === wt.id ? { ...w, ...wt } : w))
          : [...list, wt]
        return { ...ws, worktrees: next }
      }),
    }))
  },

  removeWorktree(wsId, worktreeId) {
    set((state) => ({
      workspaces: state.workspaces.map((ws) => {
        if (ws.id !== wsId) return ws
        const list = (ws.worktrees ?? []).filter((w) => w.id !== worktreeId)
        // Strip the worktreeId from any panel tagged with it.
        const panels = Object.fromEntries(
          Object.entries(ws.panels).map(([id, p]) => [
            id,
            p.worktreeId === worktreeId ? { ...p, worktreeId: undefined } : p,
          ]),
        )
        return { ...ws, worktrees: list, panels }
      }),
    }))
  },

  setWorktreeColor(wsId, worktreeId, color) {
    set((state) => ({
      workspaces: state.workspaces.map((ws) => {
        if (ws.id !== wsId) return ws
        const list = (ws.worktrees ?? []).map((w) =>
          w.id === worktreeId ? { ...w, color } : w,
        )
        return { ...ws, worktrees: list }
      }),
    }))
  },

  setWorktreeLabel(wsId, worktreeId, label) {
    const trimmed = label?.trim()
    set((state) => ({
      workspaces: state.workspaces.map((ws) => {
        if (ws.id !== wsId) return ws
        const list = (ws.worktrees ?? []).map((w) =>
          w.id === worktreeId ? { ...w, label: trimmed || undefined } : w,
        )
        return { ...ws, worktrees: list }
      }),
    }))
  },

  setPanelWorktreeId(wsId, panelId, worktreeId) {
    setPanelField(set, wsId, panelId, (panel) => ({ ...panel, worktreeId }))
  },

  closeAllPanels(wsId) {
    const ws = get().workspaces.find((w) => w.id === wsId)
    if (!ws) return

    // Dispose any terminal panels via the registry (handles PTY kill, xterm
    // disposal, listener cleanup, and shell unregister), and release the
    // workspace's canvas stores since their panels are about to be wiped.
    const canvasPanelIds: string[] = []
    for (const panel of Object.values(ws.panels)) {
      if (panel.type === 'terminal') terminalRegistry.dispose(panel.id)
      if (panel.type === 'canvas') canvasPanelIds.push(panel.id)
    }

    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.id === wsId ? { ...w, panels: {}, canvasNodes: {} } : w,
      ),
    }))

    for (const id of canvasPanelIds) {
      try { releaseCanvasStoreForPanel(id) } catch { /* ignore */ }
    }

    // Reset the workspace's OWN dock store so the just-cleared panel IDs don't
    // linger as orphan tabs (which render as a generic "Panel" tab), then mint a
    // fresh canvas panel for the center zone.
    getOrCreateWorkspaceDockStore(wsId).getState().restoreSnapshot(createCleanDockSnapshot())
    get().ensureCenterCanvas(wsId)
  },

  // --- Cross-window sync ---

  mergeWorkspaceInfos(infos) {
    set((state) => {
      const existingMap = new Map(state.workspaces.map((ws) => [ws.id, ws]))

      // Update metadata for existing workspaces, add new ones
      const updatedIds = new Set<string>()
      for (const info of infos) {
        updatedIds.add(info.id)
        const existing = existingMap.get(info.id)
        if (existing) {
          // Merge metadata only — don't touch panels/canvas state
          if (
            existing.name !== info.name ||
            existing.color !== info.color ||
            existing.rootPath !== info.rootPath ||
            (existing.connection && existing.connection.kind !== 'local' ? existing.connection.companionId : undefined) !==
              (info.connection && info.connection.kind !== 'local' ? info.connection.companionId : undefined)
          ) {
          existingMap.set(info.id, {
            ...existing,
            name: info.name,
            color: info.color,
            rootPath: info.rootPath,
            connection: info.connection ?? existing.connection,
            rootPathError: null,
            isRootPathPending: false,
          })
          }
        } else {
          // New workspace from another window — create empty local state
          existingMap.set(info.id, {
            id: info.id,
            name: info.name,
            color: info.color,
            rootPath: info.rootPath,
            connection: info.connection,
            rootPathError: null,
            isRootPathPending: false,
            panels: {},
            canvasNodes: {},
            regions: {},
            zoomLevel: ZOOM_DEFAULT,
            viewportOffset: { x: 0, y: 0 },
            focusedNodeId: null,
          })
        }
      }

      // Remove workspaces that no longer exist in main (deleted from another window)
      // But keep the currently selected workspace to avoid breaking the UI
      const workspaces = Array.from(existingMap.values()).filter(
        (ws) => updatedIds.has(ws.id) || ws.id === state.selectedWorkspaceId,
      )

      return { workspaces }
    })
  },
}))

// -----------------------------------------------------------------------------
// Cross-window workspace sync — subscribe to main-process broadcasts
// -----------------------------------------------------------------------------

let workspaceSyncCleanup: (() => void) | null = null

export function setupWorkspaceSync(): () => void {
  if (workspaceSyncCleanup) return workspaceSyncCleanup

  const unsubscribe = window.electronAPI.onWorkspaceChanged((infos) => {
    useAppStore.getState().mergeWorkspaceInfos(infos)
  })

  // Reflect the live companion phase on the matching workspace. This broadcast
  // is the authoritative writer once a workspace has a stored connection record
  // (companionId); the connect/ensure/reinstall actions only seed/finalize the
  // phase around their IPC calls. All writes funnel through the one setter so
  // the canonical field can't be set two different ways.
  const unsubscribeStatus = window.electronAPI.onCompanionStatus((evt) => {
    const store = useAppStore.getState()
    // The LOCAL daemon is a singleton; its phase is global, not per-workspace.
    if (evt.companionId === LOCAL_COMPANION_ID) {
      store.setLocalCompanionPhase(evt.phase)
      return
    }
    const target = store.workspaces.find(
      (ws) => ws.connection && ws.connection.kind !== 'local' && ws.connection.companionId === evt.companionId,
    )
    if (target) store.setWorkspaceCompanionPhase(target.id, evt.phase, evt.message ?? null)
  })

  // Seed the LOCAL phase once: the startup connect may have finished (or failed)
  // before this listener attached, so a live event alone could miss it. Subscribe
  // FIRST (above), then snapshot — and don't clobber a live event that already
  // landed (only seed while still unknown).
  void window.electronAPI
    .companionLocalStatus()
    .then((s) => {
      if (useAppStore.getState().localCompanionPhase === null) {
        useAppStore.getState().setLocalCompanionPhase(s.phase as CompanionPhase)
      }
    })
    .catch(() => { /* best-effort seed; live events still drive updates */ })

  workspaceSyncCleanup = () => {
    unsubscribe()
    unsubscribeStatus()
    workspaceSyncCleanup = null
  }

  return workspaceSyncCleanup
}

// -----------------------------------------------------------------------------
// Granular selectors
// -----------------------------------------------------------------------------

/** Returns the selected workspace. Uses shallow equality to avoid re-renders
 *  when unrelated workspaces change. */
export function useSelectedWorkspace(): WorkspaceState | undefined {
  return useStoreWithEqualityFn(
    useAppStore,
    (s) => s.workspaces.find((w) => w.id === s.selectedWorkspaceId),
    shallow,
  )
}

/** Returns just the panels record of the selected workspace. */
export function useWorkspacePanels(): Record<string, PanelState> | undefined {
  return useAppStore(
    (s) => s.workspaces.find((w) => w.id === s.selectedWorkspaceId)?.panels,
  )
}

/** Returns workspaces array, re-rendering on add/remove/reorder and metadata changes (name, color, rootPath). */
export function useWorkspaceList(): WorkspaceState[] {
  return useStoreWithEqualityFn(
    useAppStore,
    (s) => s.workspaces,
    (a, b) => {
      if (a.length !== b.length) return false
      for (let i = 0; i < a.length; i++) {
        if (
          a[i].id !== b[i].id ||
          a[i].name !== b[i].name ||
          a[i].color !== b[i].color ||
          a[i].rootPath !== b[i].rootPath ||
          a[i].rootPathError !== b[i].rootPathError ||
          a[i].isRootPathPending !== b[i].isRootPathPending ||
          a[i].companion?.phase !== b[i].companion?.phase ||
          a[i].companion?.error !== b[i].companion?.error
        ) return false
      }
      return true
    },
  )
}
