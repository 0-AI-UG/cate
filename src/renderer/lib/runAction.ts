// =============================================================================
// runAction — the single source of truth for menu / shortcut / command-palette
// actions. Both the global keyboard handler (useShortcuts) and the Cmd+K command
// palette dispatch through here, so the two can never drift: a "New Terminal"
// fired from ⌘T and from the palette take the exact same path — including the
// context-aware placement (drop onto the focused canvas, or tab into the focused
// dock stack) and the ensure-folder prompt.
// =============================================================================

import type { StoreApi } from 'zustand'
import {
  useAppStore,
  getActiveCanvasOps,
  placementForActivePanel,
} from '../stores/appStore'
import { useUIStore, getSidebarLayout } from '../stores/uiStore'
import { useSearchStore } from '../stores/searchStore'
import type { MenuActionId, ShortcutAction } from '../../shared/types'
import type { CanvasStore } from '../stores/canvasStore'
import { confirmClosePanels } from './confirmClosePanels'

/**
 * Ensures the workspace has a rootPath before proceeding.
 * If no rootPath is set, opens the folder dialog first.
 * Returns the workspaceId if ready, or null if the user cancelled.
 */
export async function ensureWorkspaceFolder(workspaceId: string): Promise<string | null> {
  const ws = useAppStore.getState().getWorkspace(workspaceId)
  if (ws?.rootPath) return workspaceId

  const folderPath = await window.electronAPI.openFolderDialog()
  if (!folderPath) return null

  useAppStore.getState().setWorkspaceRootPath(workspaceId, folderPath)
  return workspaceId
}

/**
 * Run a shortcut/menu/command-palette action. Re-reads store state at call time
 * so it's safe to invoke at any moment. `canvasStoreApi` is the fallback canvas
 * store used when no active canvas can be resolved (single-canvas / detached
 * windows) — pass the value from `useCanvasStoreApi()`.
 */
export async function runAction(
  action: MenuActionId,
  canvasStoreApi: StoreApi<CanvasStore>,
): Promise<void> {
  // Resolve the *active* canvas store at call time rather than binding to a
  // store captured on mount. The visible canvas is a per-panel store;
  // getActiveCanvasOps derives it from the canonical active panel, falling back
  // to the passed store for single-canvas / detached windows.
  const canvasStore = () => (getActiveCanvasOps()?.storeApi ?? canvasStoreApi).getState()
  const appStore = useAppStore.getState
  const selectedWorkspaceId = appStore().selectedWorkspaceId

  // Menu-only actions first
  if (action === 'openFolder') {
    const folder = await window.electronAPI.openFolderDialog()
    if (folder) {
      useAppStore.getState().setWorkspaceRootPath(selectedWorkspaceId, folder)
    }
    return
  }
  if (action === 'reloadWorkspace') {
    const { reloadActiveWorkspaceFromDisk } = await import('./workspace/session')
    await reloadActiveWorkspaceFromDisk()
    return
  }
  if (action === 'manageLayouts') {
    useUIStore.getState().setShowLayoutsDialog(true)
    return
  }

  switch (action as ShortcutAction) {
    case 'newTerminal': {
      const placement = placementForActivePanel()
      const wsId = await ensureWorkspaceFolder(selectedWorkspaceId)
      if (wsId) appStore().createTerminal(wsId, undefined, undefined, placement)
      break
    }
    case 'newBrowser': {
      const placement = placementForActivePanel()
      const wsId = await ensureWorkspaceFolder(selectedWorkspaceId)
      if (wsId) appStore().createBrowser(wsId, undefined, undefined, placement)
      break
    }
    case 'newEditor':
    case 'newFile': {
      const placement = placementForActivePanel()
      const wsId = await ensureWorkspaceFolder(selectedWorkspaceId)
      if (wsId) appStore().createEditor(wsId, undefined, undefined, placement)
      break
    }
    case 'newAgent': {
      const placement = placementForActivePanel()
      const wsId = await ensureWorkspaceFolder(selectedWorkspaceId)
      if (wsId) appStore().createAgent(wsId, undefined, placement)
      break
    }
    case 'newCanvas': {
      const placement = placementForActivePanel()
      const wsId = await ensureWorkspaceFolder(selectedWorkspaceId)
      if (wsId) appStore().createCanvas(wsId, undefined, placement)
      break
    }
    case 'closePanel': {
      const focusedNodeId = canvasStore().focusedNodeId
      if (focusedNodeId) {
        const node = canvasStore().nodes[focusedNodeId]
        if (node && (await confirmClosePanels(selectedWorkspaceId, [node.panelId]))) {
          appStore().closePanel(selectedWorkspaceId, node.panelId)
        }
      }
      break
    }
    case 'toggleSidebar':
      useUIStore.getState().toggleSidebar()
      break
    case 'toggleFileExplorer': {
      const ui = useUIStore.getState()
      const side = getSidebarLayout().left.includes('explorer') ? 'left' : 'right'
      if (side === 'left') {
        ui.setActiveLeftSidebarView(ui.activeLeftSidebarView === 'explorer' ? null : 'explorer')
      } else {
        ui.setActiveRightSidebarView(ui.activeRightSidebarView === 'explorer' ? null : 'explorer')
      }
      break
    }
    case 'toggleSearch': {
      const ui = useUIStore.getState()
      const side = getSidebarLayout().left.includes('search') ? 'left' : 'right'
      const active = side === 'left' ? ui.activeLeftSidebarView : ui.activeRightSidebarView
      const next = active === 'search' ? null : 'search'
      if (side === 'left') ui.setActiveLeftSidebarView(next)
      else ui.setActiveRightSidebarView(next)
      if (next === 'search') useSearchStore.getState().requestFocus()
      break
    }
    case 'toggleMinimap':
      useUIStore.getState().toggleMinimapOpen()
      break
    case 'nodeSwitcher':
      useUIStore.getState().setShowNodeSwitcher(true)
      break
    case 'commandPalette':
      useUIStore.getState().setShowCommandPalette(true)
      break
    case 'zoomIn':
      canvasStore().animateZoomTo(canvasStore().zoomLevel + 0.1)
      break
    case 'zoomOut':
      canvasStore().animateZoomTo(canvasStore().zoomLevel - 0.1)
      break
    case 'zoomReset':
      canvasStore().animateZoomTo(1.0)
      break
    case 'focusNext': {
      const next = canvasStore().nextNode()
      if (next) canvasStore().focusNode(next)
      break
    }
    case 'focusPrevious': {
      const prev = canvasStore().previousNode()
      if (prev) canvasStore().focusNode(prev)
      break
    }
    case 'saveFile':
      window.dispatchEvent(new CustomEvent('save-file'))
      break
    case 'zoomToFit':
      canvasStore().zoomToFit()
      break
    case 'zoomToSelection':
      canvasStore().zoomToSelection()
      break
    case 'toolSelect':
      useUIStore.getState().setActiveTool('select')
      break
    case 'toolHand':
      useUIStore.getState().setActiveTool('hand')
      break
    case 'navigateUp':
      canvasStore().navigateSelect('up')
      break
    case 'navigateDown':
      canvasStore().navigateSelect('down')
      break
    case 'navigateLeft':
      canvasStore().navigateSelect('left')
      break
    case 'navigateRight':
      canvasStore().navigateSelect('right')
      break
    case 'panUp':
      canvasStore().panViewport('up')
      break
    case 'panDown':
      canvasStore().panViewport('down')
      break
    case 'panLeft':
      canvasStore().panViewport('left')
      break
    case 'panRight':
      canvasStore().panViewport('right')
      break
    case 'autoLayout':
      canvasStore().autoLayout()
      break
    case 'undo':
      canvasStore().undo()
      break
    case 'redo':
      canvasStore().redo()
      break
    case 'deleteNode': {
      const focusedId = canvasStore().focusedNodeId
      if (focusedId && canvasStore().nodes[focusedId]) {
        const node = canvasStore().nodes[focusedId]
        if (await confirmClosePanels(selectedWorkspaceId, [node.panelId])) {
          appStore().closePanel(selectedWorkspaceId, node.panelId)
        }
      }
      break
    }
  }
}
