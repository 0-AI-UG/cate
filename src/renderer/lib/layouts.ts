import type { StoreApi } from 'zustand'
import type { CanvasNodeState, DockLayoutNode, PanelState, Point } from '../../shared/types'
import type { CanvasStore } from '../stores/canvasStore'
import {
  useAppStore,
  getActiveCanvasPanelId,
  ensureCanvasOpsForPanel,
} from '../stores/appStore'
import { setActivePanel } from './activePanel'
import { useUIStore } from '../stores/uiStore'
import { collectPanelIds } from '../../shared/collectPanelIds'
import { getNodeDockLayout } from './workspace/canvasAccess'
import { getDefaultSession } from '../drag/session'
import { generateId } from '../stores/canvas/helpers'
import log from './logger'

/** Reusable, lossless canvas template. Version 1 is the only accepted format. */
export interface LayoutSnapshot {
  version: 1
  canvas: {
    nodes: Record<string, CanvasNodeState>
    zoomLevel: number
    viewportOffset: Point
  }
  panels: Record<string, PanelState>
}

export function buildLayoutSnapshot(canvasApi: StoreApi<CanvasStore>): LayoutSnapshot {
  const state = canvasApi.getState()
  const app = useAppStore.getState()
  const workspace = app.workspaces.find((w) => w.id === app.selectedWorkspaceId)
  const canvasPanelId = getDefaultSession().getPanelIdForCanvasStore(canvasApi) ?? getActiveCanvasPanelId()
  const nodes: Record<string, CanvasNodeState> = {}
  const panelIds = new Set<string>()

  for (const [nodeId, node] of Object.entries(state.nodes)) {
    const dockLayout = canvasPanelId ? getNodeDockLayout(canvasPanelId, nodeId) : node.dockLayout ?? null
    if (!dockLayout) continue
    if (dockLayout) nodes[nodeId] = { ...node, dockLayout }
    collectPanelIds(dockLayout, panelIds)
  }

  const panels: Record<string, PanelState> = {}
  for (const panelId of panelIds) {
    const panel = workspace?.panels[panelId]
    if (panel && panel.type !== 'canvas') panels[panelId] = { ...panel }
  }

  return {
    version: 1,
    canvas: {
      nodes,
      zoomLevel: state.zoomLevel,
      viewportOffset: { ...state.viewportOffset },
    },
    panels,
  }
}

export async function saveLayout(name: string, canvasApi: StoreApi<CanvasStore>): Promise<void> {
  await window.electronAPI.layoutSave(name, buildLayoutSnapshot(canvasApi))
  useUIStore.getState().bumpLayoutsVersion()
}

export async function deleteLayout(name: string): Promise<void> {
  await window.electronAPI.layoutDelete(name)
  useUIStore.getState().bumpLayoutsVersion()
}

export async function listLayouts(): Promise<string[]> {
  return (await window.electronAPI.layoutList()).sort((a, b) => a.localeCompare(b))
}

async function fetchSnapshot(name: string): Promise<LayoutSnapshot | null> {
  const value = await window.electronAPI.layoutLoad(name)
  if (!value || typeof value !== 'object') return null
  const snapshot = value as Partial<LayoutSnapshot>
  if (snapshot.version !== 1 || !snapshot.canvas || !snapshot.panels) return null
  return snapshot as LayoutSnapshot
}

function remapDockTree(
  layout: DockLayoutNode | null | undefined,
  panelIds: Map<string, string>,
): DockLayoutNode | null {
  if (!layout) return null
  if (layout.type === 'tabs') {
    const mapped = layout.panelIds.flatMap((id) => panelIds.get(id) ?? [])
    if (mapped.length === 0) return null
    return {
      ...layout,
      id: generateId(),
      panelIds: mapped,
      activeIndex: Math.min(layout.activeIndex, mapped.length - 1),
    }
  }
  const children = layout.children
    .map((child) => remapDockTree(child, panelIds))
    .filter((child): child is DockLayoutNode => child !== null)
  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  return { ...layout, id: generateId(), children, ratios: children.map(() => 1 / children.length) }
}

function instantiateSnapshot(snapshot: LayoutSnapshot): {
  nodes: Record<string, CanvasNodeState>
  panels: PanelState[]
} {
  const panelIds = new Map(Object.keys(snapshot.panels).map((id) => [id, generateId()]))
  const panels = Object.values(snapshot.panels).map((panel) => ({
    ...panel,
    id: panelIds.get(panel.id)!,
  }))
  const nodes: Record<string, CanvasNodeState> = {}
  for (const node of Object.values(snapshot.canvas.nodes)) {
    const dockLayout = remapDockTree(node.dockLayout, panelIds)
    if (!dockLayout) continue
    const id = generateId()
    nodes[id] = { ...node, id, dockLayout }
  }
  return { nodes, panels }
}

function applyLayoutToCanvas(
  wsId: string,
  canvasPanelId: string,
  canvasApi: StoreApi<CanvasStore>,
  snapshot: LayoutSnapshot,
): void {
  const app = useAppStore.getState()
  app.clearCanvas(wsId, canvasPanelId)
  const instance = instantiateSnapshot(snapshot)
  for (const panel of instance.panels) app.addPanel(wsId, panel)
  canvasApi.getState().loadWorkspaceCanvas(
    instance.nodes,
    snapshot.canvas.viewportOffset,
    snapshot.canvas.zoomLevel,
  )
  ensureCanvasOpsForPanel(canvasPanelId)
  setActivePanel(canvasPanelId)
  canvasApi.getState().zoomToFit()
}

export async function loadLayoutIntoActiveCanvas(name: string): Promise<boolean> {
  try {
    const snapshot = await fetchSnapshot(name)
    if (!snapshot) return false
    const wsId = useAppStore.getState().selectedWorkspaceId
    const canvasPanelId = getActiveCanvasPanelId()
    if (!canvasPanelId) return false
    const ops = ensureCanvasOpsForPanel(canvasPanelId)
    applyLayoutToCanvas(wsId, canvasPanelId, ops.storeApi, snapshot)
    return true
  } catch (error) {
    log.error('[layouts] load (active canvas) failed', error)
    return false
  }
}

export async function loadLayoutIntoCanvas(
  name: string,
  wsId: string,
  canvasPanelId: string,
  canvasApi: StoreApi<CanvasStore>,
): Promise<boolean> {
  try {
    const snapshot = await fetchSnapshot(name)
    if (!snapshot) return false
    applyLayoutToCanvas(wsId, canvasPanelId, canvasApi, snapshot)
    return true
  } catch (error) {
    log.error('[layouts] load (into canvas) failed', error)
    return false
  }
}
