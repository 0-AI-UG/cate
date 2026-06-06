// =============================================================================
// layouts — shared logic for saving/restoring named canvas layouts.
//
// Backed by the main-process electron-store (window.electronAPI.layout*). Used
// by SavedLayoutsDialog, the empty-canvas overlay, the native Layouts menu, and
// useShortcuts. Two restore modes:
//   • loadLayoutReplacingWorkspace — wipes the whole workspace and rebuilds it
//     from the snapshot (dialog / native-menu pick).
//   • loadLayoutIntoCanvas — populates one specific (empty) canvas without
//     touching the rest of the workspace (empty-canvas overlay).
// =============================================================================

import type { StoreApi } from 'zustand'
import type { Point } from '../../shared/types'
import type { CanvasStore } from '../stores/canvasStore'
import {
  useAppStore,
  getWorkspaceCanvasStore,
  getWorkspaceCanvasPanelId,
  ensureCanvasOpsForPanel,
} from '../stores/appStore'
import { setActivePanel } from './activePanel'
import { useUIStore } from '../stores/uiStore'
import { openFileAsPanel } from './fs/fileRouting'
import log from './logger'

interface LayoutNode {
  panelType: string
  origin: Point
  size: { width: number; height: number }
  filePath?: string
  url?: string
}

export interface LayoutSnapshot {
  nodes: LayoutNode[]
  zoomLevel: number
  viewportOffset: Point
}

/** Capture the current canvas arrangement (panels) as a snapshot. */
export function buildLayoutSnapshot(canvasApi: StoreApi<CanvasStore>): LayoutSnapshot {
  const state = canvasApi.getState()
  const appState = useAppStore.getState()
  const workspace = appState.workspaces.find((w) => w.id === appState.selectedWorkspaceId)
  return {
    nodes: Object.values(state.nodes).map((n) => {
      const panel = workspace?.panels[n.panelId]
      return {
        panelType: panel?.type ?? 'terminal',
        origin: n.origin,
        size: n.size,
        filePath: panel?.filePath,
        url: panel?.url,
      }
    }),
    zoomLevel: state.zoomLevel,
    viewportOffset: state.viewportOffset,
  }
}

/** Save the current canvas under `name` and notify open surfaces to refresh. */
export async function saveLayout(name: string, canvasApi: StoreApi<CanvasStore>): Promise<void> {
  await window.electronAPI.layoutSave(name, buildLayoutSnapshot(canvasApi))
  useUIStore.getState().bumpLayoutsVersion()
}

/** Delete a saved layout and notify open surfaces to refresh. */
export async function deleteLayout(name: string): Promise<void> {
  await window.electronAPI.layoutDelete(name)
  useUIStore.getState().bumpLayoutsVersion()
}

/** List saved layout names, sorted. */
export async function listLayouts(): Promise<string[]> {
  const list = await window.electronAPI.layoutList()
  return list.sort((a, b) => a.localeCompare(b))
}

async function fetchSnapshot(name: string): Promise<LayoutSnapshot | null> {
  const snap = await window.electronAPI.layoutLoad(name)
  return (snap as LayoutSnapshot | null) ?? null
}

/** Recreate a snapshot's panels into whichever canvas is currently active. */
function recreateNodes(wsId: string, snap: LayoutSnapshot): void {
  const app = useAppStore.getState()
  for (const node of snap.nodes ?? []) {
    switch (node.panelType) {
      case 'terminal': app.createTerminal(wsId, undefined, node.origin); break
      case 'document':
      case 'editor':   openFileAsPanel(wsId, node.filePath ?? '', node.origin); break
      case 'browser':  app.createBrowser(wsId, node.url, node.origin); break
    }
  }
}

/**
 * Replace the entire active workspace with the named layout. Mirrors the
 * original dialog behavior: wipe every panel, recreate the center canvas, then
 * rebuild nodes and zoom to fit.
 */
export async function loadLayoutReplacingWorkspace(name: string): Promise<boolean> {
  try {
    const snap = await fetchSnapshot(name)
    if (!snap) return false

    const wsId = useAppStore.getState().selectedWorkspaceId
    const app = useAppStore.getState()
    app.closeAllPanels(wsId)
    // closeAllPanels wipes every panel — including the 'canvas' host panel that
    // owns the dock center zone. Recreate it before adding nodes.
    app.ensureCenterCanvas(wsId)
    // The React CanvasPanel that would register the canvas store + mark it
    // active hasn't mounted yet. Register synchronously so create* calls below
    // resolve to the *new* canvas, not the disposed one.
    const newCanvasId = getWorkspaceCanvasPanelId(wsId)
    if (newCanvasId) {
      ensureCanvasOpsForPanel(newCanvasId)
      setActivePanel(newCanvasId)
    }

    recreateNodes(wsId, snap)

    const freshCanvas = getWorkspaceCanvasStore(wsId)
    freshCanvas?.getState().zoomToFit()
    return true
  } catch (err) {
    log.error('[layouts] load (replace) failed', err)
    return false
  }
}

/**
 * Populate one specific (typically empty) canvas with the named layout without
 * disturbing the rest of the workspace. Used by the empty-canvas overlay.
 */
export async function loadLayoutIntoCanvas(
  name: string,
  wsId: string,
  canvasPanelId: string,
  canvasApi: StoreApi<CanvasStore>,
): Promise<boolean> {
  try {
    const snap = await fetchSnapshot(name)
    if (!snap) return false

    // Route new nodes into this canvas specifically.
    ensureCanvasOpsForPanel(canvasPanelId)
    setActivePanel(canvasPanelId)

    recreateNodes(wsId, snap)

    canvasApi.getState().zoomToFit()
    return true
  } catch (err) {
    log.error('[layouts] load (into canvas) failed', err)
    return false
  }
}
