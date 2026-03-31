// =============================================================================
// App Store — Zustand state for workspaces and panel management.
// Ported from Workspace.swift + AppState
// =============================================================================

import { create } from 'zustand'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import { shallow } from 'zustand/shallow'
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
  createDiffEditor: (workspaceId: string, filePath: string, diffMode: 'staged' | 'working', position?: Point) => string
  createGit: (workspaceId: string, position?: Point) => string
  createFileExplorer: (workspaceId: string, position?: Point) => string
  createProjectList: (workspaceId: string, position?: Point) => string

  // Panel management
  closePanel: (workspaceId: string, panelId: string) => void
  updatePanelTitle: (workspaceId: string, panelId: string, title: string) => void
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
    const isFirst = get().workspaces.length === 0
    set((state) => ({
      workspaces: [...state.workspaces, ws],
      // Auto-select if this is the first workspace
      selectedWorkspaceId: state.workspaces.length === 0 ? ws.id : state.selectedWorkspaceId,
    }))
    // When auto-selected as the first workspace, load its (empty) canvas
    if (isFirst) {
      useCanvasStore.getState().loadWorkspaceCanvas(
        ws.canvasNodes,
        ws.viewportOffset,
        ws.zoomLevel,
        ws.focusedNodeId,
        ws.regions,
      )
    }
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

    const wasSelected = get().selectedWorkspaceId === id

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

    // If the removed workspace was selected, load the new workspace's canvas
    if (wasSelected) {
      const newWs = get().workspaces.find((w) => w.id === get().selectedWorkspaceId)
      if (newWs) {
        useCanvasStore.getState().loadWorkspaceCanvas(
          newWs.canvasNodes,
          newWs.viewportOffset,
          newWs.zoomLevel,
          newWs.focusedNodeId,
          newWs.regions,
        )
      }
    }
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

  createDiffEditor(workspaceId, filePath, diffMode, position?) {
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

    if (workspaceId === get().selectedWorkspaceId) {
      const nodeId = useCanvasStore.getState().addNode(panelId, 'editor', position)
      useCanvasStore.getState().focusAndCenter(nodeId)
    }

    return panelId
  },

  createGit(workspaceId, position?) {
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
    if (workspaceId === get().selectedWorkspaceId) {
      const nodeId = useCanvasStore.getState().addNode(panelId, 'git', position)
      useCanvasStore.getState().focusAndCenter(nodeId)
    }
    return panelId
  },

  createFileExplorer(workspaceId, position?) {
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
    if (workspaceId === get().selectedWorkspaceId) {
      const nodeId = useCanvasStore.getState().addNode(panelId, 'fileExplorer', position)
      useCanvasStore.getState().focusAndCenter(nodeId)
    }
    return panelId
  },

  createProjectList(workspaceId, position?) {
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
    if (workspaceId === get().selectedWorkspaceId) {
      const nodeId = useCanvasStore.getState().addNode(panelId, 'projectList', position)
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
      const canvas = useCanvasStore.getState()
      for (const nodeId of Object.keys(canvas.nodes)) {
        canvas.removeNode(nodeId)
      }
    }
  },
}))

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
