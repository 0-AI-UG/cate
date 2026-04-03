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
  PanelState,
  PanelType,
  Point,
  Size,
  DockZonePosition,
} from '../../shared/types'
import { PANEL_DEFAULT_SIZES, ZOOM_DEFAULT } from '../../shared/types'
import type { CanvasNodeId, CanvasNodeState, CanvasRegion } from '../../shared/types'
import type { StoreApi } from 'zustand'
import type { CanvasStore } from './canvasStore'
import { terminalRegistry } from '../lib/terminalRegistry'
import { useDockStore } from './dockStore'

// -----------------------------------------------------------------------------
// Canvas operations callback — injected at init to decouple from canvasStore
// -----------------------------------------------------------------------------

export interface CanvasOperations {
  addNodeAndFocus: (panelId: string, panelType: PanelType, position?: Point) => void
  removeNodeForPanel: (panelId: string) => void
  loadWorkspaceCanvas: (
    nodes: Record<CanvasNodeId, CanvasNodeState>,
    viewportOffset: Point,
    zoomLevel: number,
    focusedNodeId: CanvasNodeId | null,
    regions?: Record<string, CanvasRegion>,
  ) => void
  syncCanvasSnapshot: () => {
    nodes: Record<CanvasNodeId, CanvasNodeState>
    regions: Record<string, CanvasRegion>
    viewportOffset: Point
    zoomLevel: number
    focusedNodeId: CanvasNodeId | null
  }
  clearAllNodes: () => void
  focusPanelNode: (panelId: string) => void
  /** Access the underlying store API (needed by session restore) */
  storeApi: StoreApi<CanvasStore>
}

let canvasOps: CanvasOperations | null = null
export function setCanvasOperations(ops: CanvasOperations) { canvasOps = ops }
export function getCanvasOperations(): CanvasOperations | null { return canvasOps }

// Registry for multi-canvas support — maps canvas panel IDs to their operations
const canvasOpsRegistry = new Map<string, CanvasOperations>()
let activeCanvasPanelId: string | null = null

export function registerCanvasOps(canvasPanelId: string, ops: CanvasOperations) {
  canvasOpsRegistry.set(canvasPanelId, ops)
}
export function unregisterCanvasOps(canvasPanelId: string) {
  canvasOpsRegistry.delete(canvasPanelId)
  if (activeCanvasPanelId === canvasPanelId) activeCanvasPanelId = null
}
export function setActiveCanvasPanelId(canvasPanelId: string) {
  activeCanvasPanelId = canvasPanelId
}

/** Returns the CanvasOperations for the currently active canvas, falling back to the primary */
function getActiveCanvasOps(): CanvasOperations | null {
  if (activeCanvasPanelId) {
    const ops = canvasOpsRegistry.get(activeCanvasPanelId)
    if (ops) return ops
  }
  return canvasOps
}
import { deferredSnapshots, restoreDeferredWorkspace } from '../lib/session'

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function generateId(): string {
  return crypto.randomUUID()
}

/** Workspace accent colors, cycled through. */
export const WORKSPACE_COLORS = [
  '#007AFF', // systemBlue
  '#FF9500', // systemOrange
  '#34C759', // systemGreen
  '#AF52DE', // systemPurple
  '#FF3B30', // systemRed
  '#5AC8FA', // systemTeal
]

let colorIndex = 0
function nextColor(): string {
  const color = WORKSPACE_COLORS[colorIndex % WORKSPACE_COLORS.length]
  colorIndex++
  return color
}

function createDefaultWorkspace(name?: string, rootPath?: string): WorkspaceState {
  return {
    id: generateId(),
    name: name ?? 'Workspace',
    color: nextColor(),
    rootPath: rootPath ?? '',
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

function syncCreateToMain(ws: WorkspaceState): void {
  window.electronAPI.workspaceCreate({
    name: ws.name,
    rootPath: ws.rootPath,
    id: ws.id,
  }).catch((err) => log.warn('[workspace-sync] Create failed:', err))
}

function syncUpdateToMain(id: string, changes: Partial<Omit<WorkspaceInfo, 'id'>>): void {
  window.electronAPI.workspaceUpdate(id, changes).catch((err) => log.warn('[workspace-sync] Update failed:', err))
}

function syncRemoveFromMain(id: string): void {
  window.electronAPI.workspaceRemove(id).catch((err) => log.warn('[workspace-sync] Remove failed:', err))
}

// -----------------------------------------------------------------------------
// Panel placement — specifies where a newly created panel should go
// -----------------------------------------------------------------------------

export type PanelPlacement =
  | { target: 'canvas'; position?: Point }
  | { target: 'dock'; zone: DockZonePosition }
  | { target: 'auto' } // default: canvas

// -----------------------------------------------------------------------------
// Store interface
// -----------------------------------------------------------------------------

interface AppStoreState {
  workspaces: WorkspaceState[]
  selectedWorkspaceId: string
}

interface AppStoreActions {
  // Workspace management
  addWorkspace: (name?: string, rootPath?: string) => string
  selectWorkspace: (id: string) => Promise<void>
  removeWorkspace: (id: string) => void

  // Panel creation — each adds a PanelState to the workspace AND places it
  createTerminal: (workspaceId: string, initialInput?: string, position?: Point, placement?: PanelPlacement) => string
  createBrowser: (workspaceId: string, url?: string, position?: Point, placement?: PanelPlacement) => string
  createEditor: (workspaceId: string, filePath?: string, position?: Point, placement?: PanelPlacement) => string
  createDiffEditor: (workspaceId: string, filePath: string, diffMode: 'staged' | 'working', position?: Point, placement?: PanelPlacement) => string
  createGit: (workspaceId: string, position?: Point, placement?: PanelPlacement) => string
  createFileExplorer: (workspaceId: string, position?: Point, placement?: PanelPlacement) => string
  createProjectList: (workspaceId: string, position?: Point, placement?: PanelPlacement) => string
  createCanvas: (workspaceId: string, position?: Point, placement?: PanelPlacement) => string

  // Panel management
  closePanel: (workspaceId: string, panelId: string) => void
  updatePanelTitle: (workspaceId: string, panelId: string, title: string) => void
  updatePanelUrl: (workspaceId: string, panelId: string, url: string) => void
  setPanelDirty: (workspaceId: string, panelId: string, dirty: boolean) => void
  addPanel: (workspaceId: string, panel: PanelState) => void

  // Helpers
  getWorkspace: (id: string) => WorkspaceState | undefined
  selectedWorkspace: () => WorkspaceState | undefined

  // Sync canvas state snapshot back into workspace (call before switching)
  syncCanvasToWorkspace: (workspaceId: string) => void

  // Workspace operations
  setWorkspaceRootPath: (wsId: string, rootPath: string) => void
  setWorkspaceColor: (wsId: string, color: string) => void
  renameWorkspace: (wsId: string, name: string) => void
  duplicateWorkspace: (wsId: string) => string
  closeAllPanels: (wsId: string) => void
  reorderWorkspaces: (fromIndex: number, toIndex: number) => void

  // Cross-window sync: merge metadata from main-process broadcast
  mergeWorkspaceInfos: (infos: WorkspaceInfo[]) => void
}

export type AppStore = AppStoreState & AppStoreActions

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

/** Place a panel based on placement target. Returns true if handled (dock), false if canvas (default). */
function placePanel(
  panelId: string,
  panelType: PanelType,
  placement: PanelPlacement | undefined,
  position: Point | undefined,
  isActiveWorkspace: boolean,
): void {
  // Canvas panels go to the center dock zone, not onto a canvas as a node
  if (panelType === 'canvas') {
    useDockStore.getState().dockPanel(panelId, 'center')
    return
  }
  if (placement?.target === 'dock') {
    useDockStore.getState().dockPanel(panelId, placement.zone)
    return
  }
  // Default: place on canvas (target === 'canvas' or 'auto' or undefined)
  if (isActiveWorkspace) {
    const canvasPosition = placement?.target === 'canvas' ? placement.position ?? position : position
    const ops = getActiveCanvasOps()
    ops?.addNodeAndFocus(panelId, panelType, canvasPosition)
  }
}

export const useAppStore = create<AppStore>((set, get) => ({
  // --- State ---
  // Start empty — a default workspace is created during init only if no session is restored.
  workspaces: [],
  selectedWorkspaceId: '',

  // --- Workspace management ---

  addWorkspace(name?, rootPath?) {
    const ws = createDefaultWorkspace(name, rootPath)
    const isFirst = get().workspaces.length === 0

    // Copy canvas panel entries from an existing workspace so the shared dock
    // center zone canvas panel is present in the new workspace's panels map.
    if (!isFirst) {
      const existing = get().workspaces[0]
      if (existing) {
        for (const panel of Object.values(existing.panels)) {
          if (panel.type === 'canvas') {
            ws.panels[panel.id] = { ...panel }
          }
        }
      }
    }

    set((state) => ({
      workspaces: [...state.workspaces, ws],
      // Auto-select if this is the first workspace
      selectedWorkspaceId: state.workspaces.length === 0 ? ws.id : state.selectedWorkspaceId,
    }))
    // When auto-selected as the first workspace, load its (empty) canvas
    if (isFirst) {
      canvasOps?.loadWorkspaceCanvas(
        ws.canvasNodes,
        ws.viewportOffset,
        ws.zoomLevel,
        ws.focusedNodeId,
        ws.regions,
      )
    }
    // Sync to main process
    syncCreateToMain(ws)
    return ws.id
  },

  async selectWorkspace(id) {
    const state = get()
    if (state.selectedWorkspaceId === id) return

    // Snapshot current canvas state back into the outgoing workspace
    get().syncCanvasToWorkspace(state.selectedWorkspaceId)

    // Switch selection
    set({ selectedWorkspaceId: id })

    // Load the new workspace's canvas state into the canvas store
    const ws = get().workspaces.find((w) => w.id === id)
    if (ws) {
      try {
        canvasOps?.loadWorkspaceCanvas(
          ws.canvasNodes,
          ws.viewportOffset,
          ws.zoomLevel,
          ws.focusedNodeId,
          ws.regions,
        )
      } catch (error) {
        log.error('Failed to load canvas for workspace:', error)
      }

      // Restore dock state for the incoming workspace.
      // If the workspace has saved dock state, restore it. Otherwise reset
      // the dock to a clean state so panels from the previous workspace
      // don't bleed through. Preserve the center zone (shared canvas panel).
      try {
        if (ws.dockState) {
          useDockStore.getState().restoreSnapshot(ws.dockState)
        } else {
          const currentDock = useDockStore.getState()
          const centerZone = currentDock.zones.center
          // Build a minimal locations map containing only center-zone panels
          const centerLocations: Record<string, import('../../shared/types').PanelLocation> = {}
          if (centerZone.layout) {
            const collectPanelIds = (node: import('../../shared/types').DockLayoutNode): string[] => {
              if (node.type === 'tabs') return [...node.panelIds]
              return node.children.flatMap(collectPanelIds)
            }
            for (const pid of collectPanelIds(centerZone.layout)) {
              const loc = currentDock.panelLocations[pid]
              if (loc) centerLocations[pid] = loc
            }
          }
          useDockStore.getState().restoreSnapshot({
            zones: {
              left: { position: 'left', visible: false, size: 260, layout: null },
              right: { position: 'right', visible: false, size: 260, layout: null },
              bottom: { position: 'bottom', visible: false, size: 240, layout: null },
              center: centerZone,
            },
            locations: centerLocations,
          })
        }
      } catch (error) {
        log.error('Failed to restore dock state for workspace:', error)
      }

      // Check for deferred restore (lazy workspace loading)
      try {
        if (deferredSnapshots.has(id)) {
          await restoreDeferredWorkspace(id, canvasOps?.storeApi)
        }
      } catch (error) {
        log.error('Failed to restore deferred workspace:', error)
      }

      // Ensure the center dock zone has a canvas panel — covers the case where
      // a brand new workspace was created before any canvas panel existed yet.
      const centerAfter = useDockStore.getState().zones.center
      if (!centerAfter.layout) {
        get().createCanvas(id)
      }
    }
  },

  removeWorkspace(id) {
    // Clean up deferred snapshot if workspace was never switched to
    deferredSnapshots.delete(id)
    // Dispose terminals before removing workspace state
    get().closeAllPanels(id)

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

    // If the removed workspace was selected, load the new workspace's canvas and dock
    if (wasSelected) {
      const newWs = get().workspaces.find((w) => w.id === get().selectedWorkspaceId)
      if (newWs) {
        canvasOps?.loadWorkspaceCanvas(
          newWs.canvasNodes,
          newWs.viewportOffset,
          newWs.zoomLevel,
          newWs.focusedNodeId,
          newWs.regions,
        )
        if (newWs.dockState) {
          useDockStore.getState().restoreSnapshot(newWs.dockState)
        }
      }
    }

    // Sync to main process
    syncRemoveFromMain(id)
  },

  // --- Panel creation ---

  createTerminal(workspaceId, initialInput?, position?, placement?) {
    const panelId = generateId()
    const panel: PanelState = {
      id: panelId,
      type: 'terminal',
      title: 'Terminal',
      isDirty: false,
    }

    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.id === workspaceId
          ? { ...ws, panels: { ...ws.panels, [panelId]: panel } }
          : ws,
      ),
    }))

    try {
      placePanel(panelId, 'terminal', placement, position, workspaceId === get().selectedWorkspaceId)
    } catch (error) {
      set((state) => ({
        workspaces: state.workspaces.map((ws) =>
          ws.id === workspaceId
            ? { ...ws, panels: Object.fromEntries(
                Object.entries(ws.panels).filter(([id]) => id !== panelId)
              )}
            : ws,
        ),
      }))
      log.error('Failed to place terminal panel:', error)
      return null as unknown as string
    }

    return panelId
  },

  createBrowser(workspaceId, url?, position?, placement?) {
    const panelId = generateId()
    const panel: PanelState = {
      id: panelId,
      type: 'browser',
      title: url ?? 'Browser',
      isDirty: false,
      url: url ?? 'about:blank',
    }

    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.id === workspaceId
          ? { ...ws, panels: { ...ws.panels, [panelId]: panel } }
          : ws,
      ),
    }))

    try {
      placePanel(panelId, 'browser', placement, position, workspaceId === get().selectedWorkspaceId)
    } catch (error) {
      set((state) => ({
        workspaces: state.workspaces.map((ws) =>
          ws.id === workspaceId
            ? { ...ws, panels: Object.fromEntries(
                Object.entries(ws.panels).filter(([id]) => id !== panelId)
              )}
            : ws,
        ),
      }))
      log.error('Failed to place browser panel:', error)
      return null as unknown as string
    }

    return panelId
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

    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.id === workspaceId
          ? { ...ws, panels: { ...ws.panels, [panelId]: panel } }
          : ws,
      ),
    }))

    try {
      placePanel(panelId, 'editor', placement, position, workspaceId === get().selectedWorkspaceId)
    } catch (error) {
      set((state) => ({
        workspaces: state.workspaces.map((ws) =>
          ws.id === workspaceId
            ? { ...ws, panels: Object.fromEntries(
                Object.entries(ws.panels).filter(([id]) => id !== panelId)
              )}
            : ws,
        ),
      }))
      log.error('Failed to place editor panel:', error)
      return null as unknown as string
    }

    return panelId
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

    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.id === workspaceId
          ? { ...ws, panels: { ...ws.panels, [panelId]: panel } }
          : ws,
      ),
    }))

    try {
      placePanel(panelId, 'editor', placement, position, workspaceId === get().selectedWorkspaceId)
    } catch (error) {
      set((state) => ({
        workspaces: state.workspaces.map((ws) =>
          ws.id === workspaceId
            ? { ...ws, panels: Object.fromEntries(
                Object.entries(ws.panels).filter(([id]) => id !== panelId)
              )}
            : ws,
        ),
      }))
      log.error('Failed to place diff editor panel:', error)
      return null as unknown as string
    }

    return panelId
  },

  createGit(workspaceId, position?, placement?) {
    const panelId = generateId()
    const panel: PanelState = {
      id: panelId,
      type: 'git',
      title: 'Git',
      isDirty: false,
    }
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.id === workspaceId
          ? { ...ws, panels: { ...ws.panels, [panelId]: panel } }
          : ws,
      ),
    }))
    try {
      placePanel(panelId, 'git', placement, position, workspaceId === get().selectedWorkspaceId)
    } catch (error) {
      set((state) => ({
        workspaces: state.workspaces.map((ws) =>
          ws.id === workspaceId
            ? { ...ws, panels: Object.fromEntries(
                Object.entries(ws.panels).filter(([id]) => id !== panelId)
              )}
            : ws,
        ),
      }))
      log.error('Failed to place git panel:', error)
      return null as unknown as string
    }
    return panelId
  },

  createFileExplorer(workspaceId, position?, placement?) {
    const panelId = generateId()
    const panel: PanelState = {
      id: panelId,
      type: 'fileExplorer',
      title: 'File Explorer',
      isDirty: false,
    }
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.id === workspaceId
          ? { ...ws, panels: { ...ws.panels, [panelId]: panel } }
          : ws,
      ),
    }))
    try {
      placePanel(panelId, 'fileExplorer', placement, position, workspaceId === get().selectedWorkspaceId)
    } catch (error) {
      set((state) => ({
        workspaces: state.workspaces.map((ws) =>
          ws.id === workspaceId
            ? { ...ws, panels: Object.fromEntries(
                Object.entries(ws.panels).filter(([id]) => id !== panelId)
              )}
            : ws,
        ),
      }))
      log.error('Failed to place file explorer panel:', error)
      return null as unknown as string
    }
    return panelId
  },

  createProjectList(workspaceId, position?, placement?) {
    const panelId = generateId()
    const panel: PanelState = {
      id: panelId,
      type: 'projectList',
      title: 'Projects',
      isDirty: false,
    }
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.id === workspaceId
          ? { ...ws, panels: { ...ws.panels, [panelId]: panel } }
          : ws,
      ),
    }))
    try {
      placePanel(panelId, 'projectList', placement, position, workspaceId === get().selectedWorkspaceId)
    } catch (error) {
      set((state) => ({
        workspaces: state.workspaces.map((ws) =>
          ws.id === workspaceId
            ? { ...ws, panels: Object.fromEntries(
                Object.entries(ws.panels).filter(([id]) => id !== panelId)
              )}
            : ws,
        ),
      }))
      log.error('Failed to place project list panel:', error)
      return null as unknown as string
    }
    return panelId
  },

  createCanvas(workspaceId, position?, placement?) {
    const panelId = generateId()
    const panel: PanelState = {
      id: panelId,
      type: 'canvas',
      title: 'Canvas',
      isDirty: false,
    }
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.id === workspaceId
          ? { ...ws, panels: { ...ws.panels, [panelId]: panel } }
          : ws,
      ),
    }))
    try {
      placePanel(panelId, 'canvas', placement, position, workspaceId === get().selectedWorkspaceId)
    } catch (error) {
      set((state) => ({
        workspaces: state.workspaces.map((ws) =>
          ws.id === workspaceId
            ? { ...ws, panels: Object.fromEntries(
                Object.entries(ws.panels).filter(([id]) => id !== panelId)
              )}
            : ws,
        ),
      }))
      log.error('Failed to place canvas panel:', error)
      return null as unknown as string
    }
    return panelId
  },

  // --- Panel management ---

  closePanel(workspaceId, panelId) {
    // Dispose terminal before removing the panel
    const ws = get().workspaces.find((w) => w.id === workspaceId)
    const panel = ws?.panels[panelId]
    if (panel?.type === 'terminal') {
      terminalRegistry.dispose(panelId)
    }

    // Remove from dock/canvas first (less critical — log errors but continue)
    try {
      const dockLocation = useDockStore.getState().panelLocations[panelId]
      if (dockLocation?.type === 'dock') {
        useDockStore.getState().undockPanel(panelId)
      } else if (workspaceId === get().selectedWorkspaceId) {
        // Try all registered canvas stores (panel could be on any canvas)
        let removed = false
        for (const ops of canvasOpsRegistry.values()) {
          const nodeId = ops.storeApi.getState().nodeForPanel(panelId)
          if (nodeId) {
            ops.removeNodeForPanel(panelId)
            removed = true
            break
          }
        }
        if (!removed) canvasOps?.removeNodeForPanel(panelId)
      }
    } catch (error) {
      log.error('Failed to remove panel from dock/canvas during close:', error)
    }

    // Clean up location tracking
    try {
      useDockStore.getState().removePanelLocation(panelId)
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
    set((state) => ({
      workspaces: state.workspaces.map((ws) => {
        if (ws.id !== workspaceId) return ws
        const panel = ws.panels[panelId]
        if (!panel) return ws
        return {
          ...ws,
          panels: { ...ws.panels, [panelId]: { ...panel, title } },
        }
      }),
    }))
  },

  updatePanelUrl(workspaceId, panelId, url) {
    set((state) => ({
      workspaces: state.workspaces.map((ws) => {
        if (ws.id !== workspaceId) return ws
        const panel = ws.panels[panelId]
        if (!panel) return ws
        return {
          ...ws,
          panels: { ...ws.panels, [panelId]: { ...panel, url } },
        }
      }),
    }))
  },

  setPanelDirty(workspaceId, panelId, dirty) {
    set((state) => ({
      workspaces: state.workspaces.map((ws) => {
        if (ws.id !== workspaceId) return ws
        const panel = ws.panels[panelId]
        if (!panel) return ws
        return {
          ...ws,
          panels: { ...ws.panels, [panelId]: { ...panel, isDirty: dirty } },
        }
      }),
    }))
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
    const snapshot = canvasOps?.syncCanvasSnapshot()
    if (!snapshot) return

    // Also snapshot dock state so it's saved per workspace
    const dockSnapshot = useDockStore.getState().getSnapshot()

    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.id === workspaceId
          ? {
              ...ws,
              canvasNodes: snapshot.nodes,
              regions: snapshot.regions,
              viewportOffset: snapshot.viewportOffset,
              zoomLevel: snapshot.zoomLevel,
              focusedNodeId: snapshot.focusedNodeId,
              dockState: dockSnapshot,
            }
          : ws,
      ),
    }))
  },

  setWorkspaceRootPath(wsId, rootPath) {
    const folderName = rootPath.split('/').filter(Boolean).pop() ?? rootPath
    set((state) => ({
      workspaces: state.workspaces.map((ws) => {
        if (ws.id !== wsId) return ws
        const newName = ws.name === 'Workspace' ? folderName : ws.name
        return { ...ws, rootPath, name: newName }
      }),
    }))
    // Sync metadata to main process
    const ws = get().workspaces.find((w) => w.id === wsId)
    if (ws) {
      syncUpdateToMain(wsId, { rootPath, name: ws.name })
    }
    // Track in recent projects
    window.electronAPI.recentProjectsAdd(rootPath)
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
    set((state) => {
      const workspaces = [...state.workspaces]
      const [moved] = workspaces.splice(fromIndex, 1)
      workspaces.splice(toIndex, 0, moved)
      return { workspaces }
    })
  },

  closeAllPanels(wsId) {
    const ws = get().workspaces.find((w) => w.id === wsId)
    if (!ws) return

    // Dispose any terminal panels via the registry (handles PTY kill, xterm
    // disposal, listener cleanup, and shell unregister)
    for (const panel of Object.values(ws.panels)) {
      if (panel.type === 'terminal') {
        terminalRegistry.dispose(panel.id)
      }
    }

    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.id === wsId ? { ...w, panels: {}, canvasNodes: {} } : w,
      ),
    }))

    // Clear the canvas store if this is the active workspace
    if (wsId === get().selectedWorkspaceId) {
      canvasOps?.clearAllNodes()
    }
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
            existing.rootPath !== info.rootPath
          ) {
            existingMap.set(info.id, {
              ...existing,
              name: info.name,
              color: info.color,
              rootPath: info.rootPath,
            })
          }
        } else {
          // New workspace from another window — create empty local state
          existingMap.set(info.id, {
            id: info.id,
            name: info.name,
            color: info.color,
            rootPath: info.rootPath,
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

  workspaceSyncCleanup = () => {
    unsubscribe()
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

/** Returns the rootPath for a workspace (defaults to selected). */
export function useWorkspaceRootPath(wsId?: string): string | undefined {
  return useAppStore((s) => {
    const id = wsId ?? s.selectedWorkspaceId
    return s.workspaces.find((w) => w.id === id)?.rootPath
  })
}

/** Returns workspaces array, re-rendering only on add/remove/reorder. */
export function useWorkspaceList(): WorkspaceState[] {
  return useStoreWithEqualityFn(
    useAppStore,
    (s) => s.workspaces,
    (a, b) => {
      if (a.length !== b.length) return false
      for (let i = 0; i < a.length; i++) {
        if (a[i].id !== b[i].id) return false
      }
      return true
    },
  )
}
