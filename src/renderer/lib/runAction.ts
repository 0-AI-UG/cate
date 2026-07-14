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
import { focusedNodeId as focusedNodeIdOf } from '../stores/canvas/selectionModel'
import { provideAppStoreForHistory } from '../stores/canvas/historySlice'
import { inheritedWorktreeFromSelection } from './inheritWorktree'
import { closePanelWithConfirm } from './closePanelWithConfirm'
import { activeDockPanelId } from '../../shared/collectPanelIds'

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
  canvasStoreApi?: StoreApi<CanvasStore>,
): Promise<void> {
  // Resolve the *active* canvas store at call time rather than binding to a
  // store captured on mount. The visible canvas is a per-panel store;
  // getActiveCanvasOps derives it from the canonical active panel, falling back
  // to the passed store for single-canvas / detached windows.
  const canvasStore = () => (getActiveCanvasOps()?.storeApi ?? canvasStoreApi)?.getState()
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
    // Reload-from-disk is a workspace/main-level operation: it tears down panels,
    // re-reads .cate/, and closes+recreates the workspace's detached windows. A
    // detached window's per-window store doesn't own the real workspace, so
    // running it here would just destroy this window. Route it to the main
    // window, which owns the workspace + session.
    const windowType = new URLSearchParams(window.location.search).get('type')
    if (windowType && windowType !== 'main') {
      await window.electronAPI.runActionInMain('reloadWorkspace')
      return
    }
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
      if (wsId) {
        // Inherit the selected terminal/agent's worktree so ⌘T from inside a
        // worktree opens the new terminal in that same worktree.
        const canvas = canvasStore()
        const wt = canvas ? inheritedWorktreeFromSelection(canvas, appStore().getWorkspace(wsId)?.panels) : {}
        const panelId = appStore().createTerminal(wsId, undefined, undefined, placement, wt.cwd)
        if (panelId && wt.worktreeId) appStore().setPanelWorktreeId(wsId, panelId, wt.worktreeId)
      }
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
      if (wsId) {
        // Same worktree inheritance as newTerminal — an agent carries only a
        // worktreeId (no cwd), so bind it when the selection has one.
        const canvas = canvasStore()
        const wt = canvas ? inheritedWorktreeFromSelection(canvas, appStore().getWorkspace(wsId)?.panels) : {}
        const panelId = appStore().createAgent(wsId, undefined, placement)
        if (panelId && wt.worktreeId) appStore().setPanelWorktreeId(wsId, panelId, wt.worktreeId)
      }
      break
    }
    case 'newCanvas': {
      const placement = placementForActivePanel()
      const wsId = await ensureWorkspaceFolder(selectedWorkspaceId)
      if (wsId) appStore().createCanvas(wsId, undefined, placement)
      break
    }
    case 'closePanel': {
      const canvas = canvasStore()
      const focusedNodeId = canvas ? focusedNodeIdOf(canvas) : null
      if (focusedNodeId) {
        const node = canvas?.nodes[focusedNodeId]
        const panelId = activeDockPanelId(node?.dockLayout)
        if (panelId) await closePanelWithConfirm(selectedWorkspaceId, panelId)
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
    case 'commandPalette':
      useUIStore.getState().setShowCommandPalette(true)
      break
    case 'nextWorkspace':
      void appStore().switchWorkspaceByOffset(1)
      break
    case 'previousWorkspace':
      void appStore().switchWorkspaceByOffset(-1)
      break
    case 'zoomIn':
      { const canvas = canvasStore(); if (canvas) canvas.animateZoomTo(canvas.zoomLevel + 0.1) }
      break
    case 'zoomOut':
      { const canvas = canvasStore(); if (canvas) canvas.animateZoomTo(canvas.zoomLevel - 0.1) }
      break
    case 'zoomReset':
      canvasStore()?.animateZoomTo(1.0)
      break
    case 'focusNext': {
      const canvas = canvasStore()
      const next = canvas?.nextNode()
      if (next) canvas?.focusNode(next)
      break
    }
    case 'focusPrevious': {
      const canvas = canvasStore()
      const prev = canvas?.previousNode()
      if (prev) canvas?.focusNode(prev)
      break
    }
    case 'saveFile':
      window.dispatchEvent(new CustomEvent('save-file'))
      break
    case 'zoomToFit':
      canvasStore()?.zoomToFit()
      break
    case 'zoomToSelection':
      canvasStore()?.zoomToSelection()
      break
    case 'toggleTool': {
      const ui = useUIStore.getState()
      ui.setActiveTool(ui.activeTool === 'hand' ? 'select' : 'hand')
      break
    }
    case 'navigateUp':
      canvasStore()?.navigateSelect('up')
      break
    case 'navigateDown':
      canvasStore()?.navigateSelect('down')
      break
    case 'navigateLeft':
      canvasStore()?.navigateSelect('left')
      break
    case 'navigateRight':
      canvasStore()?.navigateSelect('right')
      break
    case 'panUp':
      canvasStore()?.panViewport('up')
      break
    case 'panDown':
      canvasStore()?.panViewport('down')
      break
    case 'panLeft':
      canvasStore()?.panViewport('left')
      break
    case 'panRight':
      canvasStore()?.panViewport('right')
      break
    case 'autoLayout':
      canvasStore()?.autoLayout()
      break
    case 'undo':
      canvasStore()?.undo()
      break
    case 'redo':
      canvasStore()?.redo()
      break
    case 'deleteNode': {
      const canvas = canvasStore()
      const focusedId = canvas ? focusedNodeIdOf(canvas) : null
      if (focusedId && canvas?.nodes[focusedId]) {
        const node = canvas.nodes[focusedId]
        const panelId = activeDockPanelId(node.dockLayout)
        if (panelId) {
          // Snapshot the record before the close so the history entry can
          // carry it — Cmd+Z then restores the panel, not a ghost node.
          const record = appStore().workspaces
            .find((w) => w.id === selectedWorkspaceId)?.panels[panelId]
          provideAppStoreForHistory(useAppStore)
          canvas.beginHistoryTransaction()
          let closed = false
          try {
            closed = await closePanelWithConfirm(selectedWorkspaceId, panelId)
          } finally {
            canvas.commitHistoryTransaction(
              closed && record ? { workspaceId: selectedWorkspaceId, panels: [record] } : undefined,
            )
          }
        }
      }
      break
    }
  }
}
