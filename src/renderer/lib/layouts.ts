// =============================================================================
// layouts — shared logic for saving/restoring named canvas layouts.
//
// Backed by the main-process electron-store (window.electronAPI.layout*). Used
// by SavedLayoutsDialog, the empty-canvas overlay, the native Layouts menu, and
// useShortcuts. A layout always loads into ONE canvas, replacing that canvas's
// contents (other canvases and dock panels are left untouched):
//   • loadLayoutIntoActiveCanvas — targets the active canvas, resolved from the
//     canonical active panel (dialog / native-menu pick).
//   • loadLayoutIntoCanvas — targets one explicit canvas (empty-canvas overlay).
// Both clear the target canvas first, then rebuild the saved nodes onto it.
// =============================================================================

import type { StoreApi } from 'zustand'
import type { Point } from '../../shared/types'
import type { CanvasStore } from '../stores/canvasStore'
import type { PanelPlacement } from '../stores/appStore'
import {
  useAppStore,
  getActiveCanvasPanelId,
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

/** Recreate a snapshot's panels onto a SPECIFIC canvas. Pins each create to
 *  `canvasPanelId` (so nodes land on the target canvas, not the workspace's
 *  primary one) and to the saved size (so geometry — and, because the placement
 *  search keys off size, position — is reproduced exactly). */
function recreateNodes(wsId: string, canvasPanelId: string, snap: LayoutSnapshot): void {
  const app = useAppStore.getState()
  for (const node of snap.nodes ?? []) {
    const placement: PanelPlacement = {
      target: 'canvas',
      canvasPanelId,
      position: node.origin,
      size: node.size,
    }
    switch (node.panelType) {
      case 'terminal': app.createTerminal(wsId, undefined, node.origin, placement); break
      case 'agent':    app.createAgent(wsId, node.origin, placement); break
      case 'browser':  app.createBrowser(wsId, node.url, node.origin, placement); break
      case 'document':
      case 'editor':
        if (node.filePath) openFileAsPanel(wsId, node.filePath, node.origin, placement)
        break
    }
  }
}

/** Replace one canvas's contents with the snapshot: clear it, rebuild the saved
 *  nodes onto it, and zoom to fit. Shared by both public load entry points. */
function applyLayoutToCanvas(
  wsId: string,
  canvasPanelId: string,
  canvasApi: StoreApi<CanvasStore>,
  snap: LayoutSnapshot,
): void {
  const app = useAppStore.getState()
  app.clearCanvas(wsId, canvasPanelId)
  // The React CanvasPanel that registers ops / marks the canvas active may not
  // be mounted (a just-opened canvas, or a background restore). Register + mark
  // active synchronously so create* calls resolve to this canvas.
  ensureCanvasOpsForPanel(canvasPanelId)
  setActivePanel(canvasPanelId)
  recreateNodes(wsId, canvasPanelId, snap)
  canvasApi.getState().zoomToFit()
}

/**
 * Load the named layout into the ACTIVE canvas (resolved from the canonical
 * active panel, falling back to the workspace's primary canvas), replacing that
 * canvas's contents. Used by the manager dialog and the native Layouts menu.
 */
export async function loadLayoutIntoActiveCanvas(name: string): Promise<boolean> {
  try {
    const snap = await fetchSnapshot(name)
    if (!snap) return false

    const wsId = useAppStore.getState().selectedWorkspaceId
    const canvasPanelId = getActiveCanvasPanelId()
    if (!canvasPanelId) return false

    const ops = ensureCanvasOpsForPanel(canvasPanelId)
    applyLayoutToCanvas(wsId, canvasPanelId, ops.storeApi, snap)
    return true
  } catch (err) {
    log.error('[layouts] load (active canvas) failed', err)
    return false
  }
}

/**
 * Load the named layout into one specific canvas, replacing its contents without
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

    applyLayoutToCanvas(wsId, canvasPanelId, canvasApi, snap)
    return true
  } catch (err) {
    log.error('[layouts] load (into canvas) failed', err)
    return false
  }
}
