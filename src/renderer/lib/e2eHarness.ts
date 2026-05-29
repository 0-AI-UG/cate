// E2E test harness — exposes a tiny inspect/seed API on window.__cateE2E
// when the app is launched with CATE_E2E=1.
//
// Why a harness: drag tests need deterministic seed (1-2 nodes at known
// positions, known zoom) and assertions against canvas-space state. Driving
// the UI for setup is brittle; reaching into stores is reliable.

import { useAppStore } from '../stores/appStore'
import { getOrCreateCanvasStoreForPanel } from '../stores/canvasStore'
import { useDragStore } from '../drag/store'
import { terminalRegistry } from './terminalRegistry'
import type { Point } from '../../shared/types'

declare global {
  interface Window {
    __cateE2E?: {
      ready: true
      activeCanvasPanelId(): string | null
      createTerminal(point: Point): string
      createCanvasPanel(point: Point): string
      nodes(): { id: string; panelId: string; origin: Point; size: { width: number; height: number } }[]
      zoom(): number
      setZoom(z: number): void
      resetViewport(): void
      /** Resolve the PTY id backing a terminal node (null until the PTY spawns). */
      terminalPtyId(nodeId: string): string | null
      /** Write raw data to a terminal node's PTY (e.g. a flooding command). */
      writeTerminal(nodeId: string, data: string): boolean
      dragSnapshot(): {
        isDragging: boolean
        sourceKind: string | null
        sourceNodeId: string | null
        targetKind: string | null
      }
    }
  }
}

export function installE2EHarness(): void {
  if (window.__cateE2E) return

  // The Canvas component stamps data-canvas-panel-id on its root — use the
  // DOM as the source of truth for which canvas is currently mounted/active.
  const activeCanvasPanelId = (): string | null => {
    const el = document.querySelector('[data-canvas-panel-id]')
    return el?.getAttribute('data-canvas-panel-id') ?? null
  }

  const activeCanvasStore = () => {
    const pid = activeCanvasPanelId()
    return pid ? getOrCreateCanvasStoreForPanel(pid) : null
  }

  const createTerminal = (point: Point): string => {
    const wsId = useAppStore.getState().selectedWorkspaceId
    const panelId = useAppStore.getState().createTerminal(wsId, undefined, point)
    const cs = activeCanvasStore()
    if (!cs) return panelId
    for (const n of Object.values(cs.getState().nodes)) {
      if (n.panelId === panelId) return n.id
    }
    return panelId
  }

  const createCanvasPanel = (point: Point): string => {
    const wsId = useAppStore.getState().selectedWorkspaceId
    useAppStore.getState().createCanvas(wsId, point)
    const cs = activeCanvasStore()
    if (!cs) return ''
    const nodes = Object.values(cs.getState().nodes)
    return nodes.length ? nodes[nodes.length - 1].id : ''
  }

  const nodes = () => {
    const cs = activeCanvasStore()
    if (!cs) return []
    return Object.values(cs.getState().nodes).map((n) => ({
      id: n.id,
      panelId: n.panelId,
      origin: { x: n.origin.x, y: n.origin.y },
      size: { width: n.size.width, height: n.size.height },
    }))
  }

  const zoom = () => activeCanvasStore()?.getState().zoomLevel ?? 1

  const setZoom = (z: number) => {
    activeCanvasStore()?.getState().setZoom(z)
  }

  const resetViewport = () => {
    activeCanvasStore()?.setState({ viewportOffset: { x: 0, y: 0 } })
  }

  const terminalPtyId = (nodeId: string): string | null => {
    const cs = activeCanvasStore()
    if (!cs) return null
    const node = cs.getState().nodes[nodeId]
    const panelId = node?.panelId ?? nodeId
    return terminalRegistry.getEntry(panelId)?.ptyId || null
  }

  const writeTerminal = (nodeId: string, data: string): boolean => {
    const ptyId = terminalPtyId(nodeId)
    if (!ptyId) return false
    void window.electronAPI?.terminalWrite(ptyId, data)
    return true
  }

  const dragSnapshot = () => {
    const s = useDragStore.getState()
    return {
      isDragging: s.isDragging,
      sourceKind: s.source?.origin.kind ?? null,
      sourceNodeId:
        s.source?.origin.kind === 'canvas-node' ? s.source.origin.nodeId : null,
      targetKind: s.target?.kind ?? null,
    }
  }

  window.__cateE2E = {
    ready: true,
    activeCanvasPanelId,
    createTerminal,
    createCanvasPanel,
    nodes,
    zoom,
    setZoom,
    resetViewport,
    terminalPtyId,
    writeTerminal,
    dragSnapshot,
  }
}
