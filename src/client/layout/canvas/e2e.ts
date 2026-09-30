// The canvas part of the e2e harness (client/ui mounts it on
// `window.__cateE2E`). Perf specs drive pan, zoom and moves through here
// because a headless mouse does not reach the canvas, and seed worktrees as
// document ops.

import { clientStateFor, documentStoreFor } from '@client/document'
import type { Point } from '@workspace/canvas/contract'
import type { NodeId, WorktreeMeta } from '@workspace/document/contract'
import { canvasViewFor } from './registry'
import { activeNodePanelId, type CanvasViewStore } from './store'

export interface CanvasE2E {
  /** The canvas mounted in this window, as [data-canvas-container] says. */
  activeCanvas(): { workspaceId: string; canvasId: string; canvasPanelId: string } | null
  nodes(): { id: NodeId; panelId: string; origin: Point; size: { width: number; height: number } }[]
  nodeForPanel(panelId: string): NodeId | null
  zoom(): number
  setZoom(zoom: number): void
  resetViewport(): void
  setViewportOffset(offset: Point): void
  /** A whole move gesture: preview, then one op. */
  moveNode(nodeId: NodeId, origin: Point): void
  /** Writes worktree metadata (index 0 is the primary checkout). */
  seedWorktrees(specs: { color: string; label?: string }[], rootPath?: string): { id: string; path: string; color: string }[]
  /** Binds a node's visible panel to a worktree. */
  tagNodeWorktree(nodeId: NodeId, worktreeId: string): boolean
  worktreeDebug(): { liveWorktrees: number; metaWorktrees: number; taggedNodes: number; distinctGroups: number; glActive: boolean }
}

export function createCanvasE2E(): CanvasE2E {
  const activeCanvas = () => {
    const el = document.querySelector<HTMLElement>('[data-canvas-container]')
    const { workspaceId, canvasId, canvasPanelId } = el?.dataset ?? {}
    return workspaceId && canvasId && canvasPanelId ? { workspaceId, canvasId, canvasPanelId } : null
  }
  const store = (): CanvasViewStore | null => {
    const active = activeCanvas()
    return active ? canvasViewFor(active.workspaceId, active.canvasId) : null
  }
  const activeTabs = () => {
    const active = activeCanvas()
    return active ? clientStateFor(active.workspaceId)?.getSnapshot().activeTabs : undefined
  }

  return {
    activeCanvas,
    nodes() {
      const s = store()
      if (!s) return []
      return Object.values(s.getState().nodes).map((n) => ({
        id: n.id,
        panelId: activeNodePanelId(n.dock, activeTabs()) ?? '',
        origin: { x: n.origin.x, y: n.origin.y },
        size: { width: n.size.width, height: n.size.height },
      }))
    },
    nodeForPanel: (panelId) => store()?.getState().nodeForPanel(panelId) ?? null,
    zoom: () => store()?.getState().zoomLevel ?? 1,
    setZoom: (zoom) => store()?.getState().setZoom(zoom),
    resetViewport: () => store()?.setState({ viewportOffset: { x: 0, y: 0 } }),
    setViewportOffset: (offset) => store()?.getState().setViewportOffset(offset),
    moveNode(nodeId, origin) {
      const s = store()?.getState()
      if (!s) return
      s.moveNode(nodeId, origin)
      s.commitPreview()
    },
    seedWorktrees(specs, rootPath) {
      const active = activeCanvas()
      const doc = active ? documentStoreFor(active.workspaceId) : null
      if (!active || !doc) return []
      const root = rootPath ?? `/private/tmp/cate-e2e-wt-${active.canvasId}`
      const metas: WorktreeMeta[] = specs.map((spec, i) => ({
        id: `wt-e2e-${i}`,
        path: i === 0 ? root : `${root}/.cate-wt/feature-${i}`,
        color: spec.color,
        ...(spec.label ? { label: spec.label } : {}),
        status: 'ready',
      }))
      doc.propose({ kind: 'batch', changes: metas.map((worktree) => ({ kind: 'setWorktree' as const, worktree })) })
      return metas.map((m) => ({ id: m.id, path: m.path, color: m.color }))
    },
    tagNodeWorktree(nodeId, worktreeId) {
      const active = activeCanvas()
      const node = store()?.getState().nodes[nodeId]
      const panelId = node ? activeNodePanelId(node.dock, activeTabs()) : null
      const doc = active ? documentStoreFor(active.workspaceId) : null
      if (!panelId || !doc) return false
      return doc.propose({ kind: 'updatePanel', id: panelId, patch: { worktreeId } }).ok
    },
    worktreeDebug() {
      const active = activeCanvas()
      const doc = active ? documentStoreFor(active.workspaceId)?.getSnapshot() : undefined
      const tags = store()?.getState().nodeActiveWorktreeId ?? {}
      const values = Object.values(tags).filter((v): v is string => !!v)
      const gl = document.querySelector<HTMLElement>('[data-worktree-territory]')
      return {
        liveWorktrees: doc ? Object.values(doc.worktrees).filter((w) => w.status === 'ready').length : 0,
        metaWorktrees: doc ? Object.keys(doc.worktrees).length : 0,
        taggedNodes: values.length,
        distinctGroups: new Set(values).size,
        glActive: !!gl && getComputedStyle(gl).display !== 'none',
      }
    },
  }
}
