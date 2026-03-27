// =============================================================================
// App Store — Zustand state for workspaces and panel management.
// Ported from Workspace.swift + AppState
// =============================================================================

import { create } from 'zustand'
import type {
  WorkspaceState,
  PanelState,
  PanelType,
  Point,
  Size,
} from '../../shared/types'
import { PANEL_DEFAULT_SIZES, ZOOM_DEFAULT } from '../../shared/types'
import { useCanvasStore } from './canvasStore'
import { terminalRegistry } from '../lib/terminalRegistry'
import { deferredSnapshots, restoreDeferredWorkspace } from '../lib/session'

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function generateId(): string {
  return crypto.randomUUID()
}

/** Workspace accent colors, cycled through. */
const WORKSPACE_COLORS = [
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
// Store interface
// -----------------------------------------------------------------------------

interface AppStoreState {
  workspaces: WorkspaceState[]
  selectedWorkspaceId: string
}

interface AppStoreActions {
  // Workspace management
  addWorkspace: (name?: string, rootPath?: string) => string
  selectWorkspace: (id: string) => void
  removeWorkspace: (id: string) => void

  // Panel creation — each adds a PanelState to the workspace AND a CanvasNode
  createTerminal: (workspaceId: string, initialInput?: string, position?: Point) => string
  createBrowser: (workspaceId: string, url?: string, position?: Point) => string
  createEditor: (workspaceId: string, filePath?: string, position?: Point) => string

  // Panel management
  closePanel: (workspaceId: string, panelId: string) => void
  updatePanelTitle: (workspaceId: string, panelId: string, title: string) => void
  setPanelDirty: (workspaceId: string, panelId: string, dirty: boolean) => void

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
}

export type AppStore = AppStoreState & AppStoreActions

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

export const useAppStore = create<AppStore>((set, get) => ({
  // --- State ---
  // Start empty — a default workspace is created during init only if no session is restored.
  workspaces: [],
  selectedWorkspaceId: '',

  // --- Workspace management ---

  addWorkspace(name?, rootPath?) {
    const ws = createDefaultWorkspace(name, rootPath)
    set((state) => ({
      workspaces: [...state.workspaces, ws],
      // Auto-select if this is the first workspace
      selectedWorkspaceId: state.workspaces.length === 0 ? ws.id : state.selectedWorkspaceId,
    }))
    return ws.id
  },

  selectWorkspace(id) {
    const state = get()
    if (state.selectedWorkspaceId === id) return

    // Snapshot current canvas state back into the outgoing workspace
    get().syncCanvasToWorkspace(state.selectedWorkspaceId)

    // Switch selection
    set({ selectedWorkspaceId: id })

    // Load the new workspace's canvas state into the canvas store
    const ws = get().workspaces.find((w) => w.id === id)
    if (ws) {
      useCanvasStore.getState().loadWorkspaceCanvas(
        ws.canvasNodes,
        ws.viewportOffset,
        ws.zoomLevel,
        ws.focusedNodeId,
        ws.regions,
      )

      // Check for deferred restore (lazy workspace loading)
      if (deferredSnapshots.has(id)) {
        restoreDeferredWorkspace(id)
      }
    }
  },

  removeWorkspace(id) {
    // Clean up deferred snapshot if workspace was never switched to
    deferredSnapshots.delete(id)
    // Dispose terminals before removing workspace state
    get().closeAllPanels(id)

    set((state) => {
      const remaining = state.workspaces.filter((w) => w.id !== id)
      if (remaining.length === 0) {
        // Always keep at least one workspace
        const fresh = createDefaultWorkspace()
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
  },

  // --- Panel creation ---

  createTerminal(workspaceId, initialInput?, position?) {
    const panelId = generateId()
    const panel: PanelState = {
      id: panelId,
      type: 'terminal',
      title: 'Terminal',
      isDirty: false,
    }

    // Add to workspace panels
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.id === workspaceId
          ? { ...ws, panels: { ...ws.panels, [panelId]: panel } }
          : ws,
      ),
    }))

    // Add canvas node (only if this is the active workspace)
    if (workspaceId === get().selectedWorkspaceId) {
      const nodeId = useCanvasStore.getState().addNode(panelId, 'terminal', position)
      useCanvasStore.getState().focusAndCenter(nodeId)
    }

    return panelId
  },

  createBrowser(workspaceId, url?, position?) {
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

    if (workspaceId === get().selectedWorkspaceId) {
      const nodeId = useCanvasStore.getState().addNode(panelId, 'browser', position)
      useCanvasStore.getState().focusAndCenter(nodeId)
    }

    return panelId
  },

  createEditor(workspaceId, filePath?, position?) {
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

    if (workspaceId === get().selectedWorkspaceId) {
      const nodeId = useCanvasStore.getState().addNode(panelId, 'editor', position)
      useCanvasStore.getState().focusAndCenter(nodeId)
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

    // Remove from workspace panels
    set((state) => ({
      workspaces: state.workspaces.map((ws) => {
        if (ws.id !== workspaceId) return ws
        const { [panelId]: _removed, ...remainingPanels } = ws.panels
        return { ...ws, panels: remainingPanels }
      }),
    }))

    // Remove associated canvas node
    if (workspaceId === get().selectedWorkspaceId) {
      const canvasState = useCanvasStore.getState()
      const nodeId = canvasState.nodeForPanel(panelId)
      if (nodeId) {
        canvasState.removeNode(nodeId)
      }
    }
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

  // --- Helpers ---

  getWorkspace(id) {
    return get().workspaces.find((w) => w.id === id)
  },

  selectedWorkspace() {
    return get().workspaces.find((w) => w.id === get().selectedWorkspaceId)
  },

  syncCanvasToWorkspace(workspaceId) {
    const canvas = useCanvasStore.getState()
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.id === workspaceId
          ? {
              ...ws,
              canvasNodes: { ...canvas.nodes },
              regions: { ...canvas.regions },
              viewportOffset: { ...canvas.viewportOffset },
              zoomLevel: canvas.zoomLevel,
              focusedNodeId: canvas.focusedNodeId,
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
        return {
          ...ws,
          rootPath,
          name: ws.name === 'Workspace' ? folderName : ws.name,
        }
      }),
    }))
    // Track in recent projects
    window.electronAPI.recentProjectsAdd(rootPath)
  },

  setWorkspaceColor(wsId, color) {
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.id === wsId ? { ...ws, color } : ws,
      ),
    }))
  },

  renameWorkspace(wsId, name) {
    const trimmed = name.trim()
    if (!trimmed) return
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.id === wsId ? { ...ws, name: trimmed } : ws,
      ),
    }))
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
    return copy.id
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
      const canvas = useCanvasStore.getState()
      for (const nodeId of Object.keys(canvas.nodes)) {
        canvas.removeNode(nodeId)
      }
    }
  },
}))
