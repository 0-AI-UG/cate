// =============================================================================
// useNodeDrag — drag-to-move hook for canvas nodes.
// Ported from CanvasNode.swift drag logic.
// Extended for Phase 3: detects when drag exits canvas bounds and transitions
// to dock-drop mode.
// =============================================================================

import { useCallback, useEffect, useRef } from 'react'
import type { StoreApi } from 'zustand'
import type { CanvasStore } from '../stores/canvasStore'
import { useSettingsStore } from '../stores/settingsStore'
import { snapToEdges, snapNodeToGrid, snapNodeToGridSelective } from '../canvas/layoutEngine'
import type { Point, Size, PanelTransferSnapshot, DockLayoutNode } from '../../shared/types'
import { createTransferSnapshot } from '../lib/panelTransfer'
import { terminalRegistry } from '../lib/terminalRegistry'
import { useDockDragStore, hitTestDropTarget, hitTestDropTargetWithStore } from './useDockDrag'
import { findNodeDockStore } from '../panels/CanvasPanel'
import { canvasDropZoneHovered } from '../docking/CanvasDropZone'
import { useAppStore } from '../stores/appStore'
import { executeDrop } from '../docking/dropExecution'

type SnapCandidate = { origin: Point; size: Size }
type SnapIndex = { cells: Map<string, SnapCandidate[]>; all: SnapCandidate[]; cellSize: number }

interface DragState {
  lastClientX: number
  lastClientY: number
  initialClientX: number  // for dead zone
  initialClientY: number  // for dead zone
  initialOrigin: Point
}

interface UseNodeDragReturn {
  isDragging: boolean
  wasDragged: React.RefObject<boolean>
  handleDragStart: (e: React.MouseEvent) => void
}

/** Check if cursor is within the canvas container element bounds, inset by
 *  the edge drop zone margin so dragging to the window edge transitions to
 *  dock-drag mode even though the canvas element spans the full center area. */
const EDGE_INSET = 60

/** Find the [data-canvas-container] element that owns a given canvas-node id.
 *  When multiple canvases coexist (e.g. a split dock with two canvas panels),
 *  the global `querySelector` would always return the first one and produce
 *  bogus "outside canvas" hits for nodes living in any other canvas. */
function getOwningCanvasContainer(nodeId: string): HTMLElement | null {
  const nodeEl = document.querySelector<HTMLElement>(`[data-node-id="${nodeId}"]`)
  return nodeEl?.closest<HTMLElement>('[data-canvas-container]') ?? null
}

function isCursorInCanvas(clientX: number, clientY: number, nodeId: string): boolean {
  const canvasEl = getOwningCanvasContainer(nodeId)
  if (!canvasEl) return true // fallback: assume in canvas
  const rect = canvasEl.getBoundingClientRect()
  return (
    clientX >= rect.left + EDGE_INSET &&
    clientX <= rect.right - EDGE_INSET &&
    clientY >= rect.top &&
    clientY <= rect.bottom - EDGE_INSET
  )
}

function isCursorOutsideWindow(clientX: number, clientY: number): boolean {
  return clientX <= 0 || clientY <= 0 || clientX >= window.innerWidth || clientY >= window.innerHeight
}

/** Walk a per-node dock layout tree and return the panelId of the *active*
 *  leaf panel — i.e. what the user is currently looking at inside the canvas
 *  node. Falls back to the first leaf if the active index is stale. */
function activeLeafPanelId(layout: DockLayoutNode | null | undefined): string | null {
  if (!layout) return null
  if (layout.type === 'tabs') {
    return layout.panelIds[layout.activeIndex] ?? layout.panelIds[0] ?? null
  }
  for (const child of layout.children) {
    const found = activeLeafPanelId(child)
    if (found) return found
  }
  return null
}

export function useNodeDrag(nodeId: string, zoomLevel: number, canvasStoreApi: StoreApi<CanvasStore>): UseNodeDragReturn {
  const dragStateRef = useRef<DragState | null>(null)
  const isDraggingRef = useRef(false)
  const dragStartedRef = useRef(false)
  const wasDraggedRef = useRef(false)
  const rafId = useRef<number>(0)
  const pendingOrigin = useRef<Point | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  // Track which axes were magnetically snapped in the last drag frame (for Bug B fix)
  const lastMagneticAxes = useRef<{ x: boolean; y: boolean }>({ x: false, y: false })
  // Track whether we've transitioned to dock-drag mode
  const inDockDragRef = useRef(false)
  // Track cross-window drag state (when cursor exits the OS window)
  const crossWindowRef = useRef<{ snapshot: PanelTransferSnapshot; panelId: string; nodeId: string } | null>(null)
  // Spatial index for snap-guide neighbor lookup (rebuilt at drag start)
  const snapIndexRef = useRef<SnapIndex | null>(null)

  // Shared cleanup logic — used by mouseup, blur handler, and unmount
  const cancelDrag = useCallback((revert?: boolean) => {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }

    const wasDragging = isDraggingRef.current
    isDraggingRef.current = false
    dragStartedRef.current = false

    if (wasDragging) {
      document.body.classList.remove('canvas-interacting')
    }

    if (rafId.current) {
      cancelAnimationFrame(rafId.current)
      rafId.current = 0
    }

    if (inDockDragRef.current) {
      inDockDragRef.current = false
      if (crossWindowRef.current) {
        crossWindowRef.current = null
        window.electronAPI.crossWindowDragCancel()
      }
      useDockDragStore.getState().endDrag()
    }

    if (revert) {
      const ds = dragStateRef.current
      if (ds) {
        canvasStoreApi.getState().moveNode(nodeId, ds.initialOrigin)
      }
    } else if (pendingOrigin.current) {
      canvasStoreApi.getState().moveNode(nodeId, pendingOrigin.current)
    }

    pendingOrigin.current = null
    snapIndexRef.current = null
    canvasStoreApi.getState().clearSnapGuides()
    if (canvasStoreApi.getState().dropTargetRegionId !== null) {
      canvasStoreApi.setState({ dropTargetRegionId: null })
    }
    dragStateRef.current = null
  }, [nodeId, canvasStoreApi])

  // Cleanup on unmount
  useEffect(() => {
    return () => cancelDrag(true)
  }, [cancelDrag])

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()

      // Abort any previous drag listeners to prevent orphaned handlers
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = null
      }

      const node = canvasStoreApi.getState().nodes[nodeId]
      if (!node || node.isPinned) return

      // Clear selection when dragging an unselected node
      const preState = canvasStoreApi.getState()
      if (!preState.selectedNodeIds.has(nodeId)) {
        preState.clearSelection()
      }

      dragStateRef.current = {
        lastClientX: e.clientX,
        lastClientY: e.clientY,
        initialClientX: e.clientX,
        initialClientY: e.clientY,
        initialOrigin: { ...node.origin },
      }
      isDraggingRef.current = true
      dragStartedRef.current = false
      wasDraggedRef.current = false
      inDockDragRef.current = false

      // Build spatial index for snap guides
      {
        const SNAP_THRESHOLD = 8
        const CELL_SIZE = SNAP_THRESHOLD * 32
        const st = canvasStoreApi.getState()
        const all: SnapCandidate[] = [
          ...Object.values(st.nodes).filter((n) => n.id !== nodeId).map((n) => ({ origin: n.origin, size: n.size })),
          ...Object.values(st.regions).map((r) => ({ origin: r.origin, size: r.size })),
        ]
        if (all.length >= 20) {
          const cells = new Map<string, SnapCandidate[]>()
          const addToCell = (cx: number, cy: number, c: SnapCandidate) => {
            const key = `${cx},${cy}`
            let bucket = cells.get(key)
            if (!bucket) { bucket = []; cells.set(key, bucket) }
            bucket.push(c)
          }
          for (const c of all) {
            const x0 = Math.floor(c.origin.x / CELL_SIZE)
            const y0 = Math.floor(c.origin.y / CELL_SIZE)
            const x1 = Math.floor((c.origin.x + c.size.width) / CELL_SIZE)
            const y1 = Math.floor((c.origin.y + c.size.height) / CELL_SIZE)
            for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) addToCell(cx, cy, c)
          }
          snapIndexRef.current = { cells, all, cellSize: CELL_SIZE }
        } else {
          snapIndexRef.current = { cells: new Map(), all, cellSize: CELL_SIZE }
        }
      }

      const handleMouseMove = (ev: MouseEvent) => {
        const ds = dragStateRef.current
        if (!ds) return

        // Dead zone: don't start moving until mouse has moved 4px
        if (!dragStartedRef.current) {
          const totalDx = ev.clientX - ds.initialClientX
          const totalDy = ev.clientY - ds.initialClientY
          if (Math.hypot(totalDx, totalDy) < 4) return
          dragStartedRef.current = true
          wasDraggedRef.current = true
          document.body.classList.add('canvas-interacting')
          // Snapshot canvas state so this drag can be undone (Cmd+Z).
          canvasStoreApi.getState().pushHistory()
        }

        // --- Dock drag mode detection ---
        // When the main window is in macOS native fullscreen, lock the drag
        // to the source canvas: no cross-window detach, no dock-drop mode,
        // no new BrowserWindow. Report the cursor as "always inside canvas"
        // so the hook never switches to dock-drag mode.
        const fullscreenLocked =
          window.electronAPI?.isMainWindowFullscreen?.() ?? false
        const inCanvas = fullscreenLocked
          ? true
          : isCursorInCanvas(ev.clientX, ev.clientY, nodeId)

        if (!inCanvas && !inDockDragRef.current) {
          // Transition to dock-drag mode
          inDockDragRef.current = true
          const currentNode = canvasStoreApi.getState().nodes[nodeId]
          if (currentNode) {
            // Resolve the actual panel that's currently visible inside the
            // canvas node — the persisted dockLayout's active leaf — instead
            // of the stale seed panelId from when addNode was called.
            const draggedPanelId =
              activeLeafPanelId(currentNode.dockLayout) ?? currentNode.panelId
            const wsId = useAppStore.getState().selectedWorkspaceId
            const ws = useAppStore.getState().workspaces.find(w => w.id === wsId)
            const panel = ws?.panels[draggedPanelId]
            useDockDragStore.getState().startDrag(
              draggedPanelId,
              panel?.type ?? 'terminal',
              panel?.title ?? 'Panel',
              { type: 'canvas', nodeId },
            )
          }
        }

        if (inCanvas && inDockDragRef.current) {
          // Cursor re-entered canvas — exit dock-drag mode
          inDockDragRef.current = false
          useDockDragStore.getState().endDrag()
        }

        if (inDockDragRef.current) {
          // In dock-drag mode: update cursor and hit-test drop targets
          const dockDrag = useDockDragStore.getState()
          dockDrag.updateCursor({ x: ev.clientX, y: ev.clientY })

          // Check if cursor is outside the window BEFORE hit testing — otherwise
          // the cursor can pass through a sibling panel's drop zone on the way out,
          // causing a local drop instead of a detach.
          const outsideWindow = isCursorOutsideWindow(ev.clientX, ev.clientY)
          if (!outsideWindow) {
            if (!canvasDropZoneHovered) {
              const target = hitTestDropTarget(ev.clientX, ev.clientY)
              dockDrag.setDropTarget(target)
            }
          } else {
            dockDrag.setDropTarget(null)
          }
          if (outsideWindow && !crossWindowRef.current && dockDrag.draggedPanelId) {
            const panel = getPanelForId(dockDrag.draggedPanelId)
            const node = canvasStoreApi.getState().nodes[nodeId]
            if (panel && node) {
              const snapshot = createTransferSnapshot(
                panel,
                { type: 'canvas', canvasId: '', canvasNodeId: nodeId },
                { origin: node.origin, size: node.size },
              )
              crossWindowRef.current = { snapshot, panelId: dockDrag.draggedPanelId, nodeId }
              window.electronAPI.crossWindowDragStart(snapshot, { x: ev.screenX, y: ev.screenY })
            }
          } else if (!outsideWindow && crossWindowRef.current) {
            // Cursor re-entered this window — cancel cross-window drag
            crossWindowRef.current = null
            window.electronAPI.crossWindowDragCancel()
          }

          return
        }

        // --- Normal canvas drag ---
        const zoom = canvasStoreApi.getState().zoomLevel
        const currentNode = canvasStoreApi.getState().nodes[nodeId]
        if (!currentNode) return

        const deltaX = (ev.clientX - ds.lastClientX) / zoom
        const deltaY = (ev.clientY - ds.lastClientY) / zoom

        ds.lastClientX = ev.clientX
        ds.lastClientY = ev.clientY

        // Accumulate position — don't update store directly
        const prev = pendingOrigin.current || currentNode.origin
        pendingOrigin.current = {
          x: prev.x + deltaX,
          y: prev.y + deltaY,
        }

        // Schedule RAF if not already pending
        if (!rafId.current) {
          rafId.current = requestAnimationFrame(() => {
            rafId.current = 0
            const origin = pendingOrigin.current
            if (!origin) return

            const currentState = canvasStoreApi.getState()
            const isInSelection = currentState.selectedNodeIds.has(nodeId)
            const isMultiDrag =
              isInSelection &&
              (currentState.selectedNodeIds.size > 1 || currentState.selectedRegionIds.size > 0)

            if (isMultiDrag) {
              // Compute delta from where this node currently is
              const currentNode = currentState.nodes[nodeId]
              if (!currentNode) {
                pendingOrigin.current = null
                return
              }
              const dx = origin.x - currentNode.origin.x
              const dy = origin.y - currentNode.origin.y

              // Batch all node + region moves into a single store update
              canvasStoreApi.setState((s) => {
                const updatedNodes = { ...s.nodes }
                for (const id of currentState.selectedNodeIds) {
                  const n = s.nodes[id]
                  if (n) updatedNodes[id] = { ...n, origin: { x: n.origin.x + dx, y: n.origin.y + dy } }
                }
                const updatedRegions = { ...s.regions }
                for (const id of currentState.selectedRegionIds) {
                  const r = s.regions[id]
                  if (r) updatedRegions[id] = { ...r, origin: { x: r.origin.x + dx, y: r.origin.y + dy } }
                }
                return { nodes: updatedNodes, regions: updatedRegions }
              })
              pendingOrigin.current = null
              return // Skip snap guides for multi-drag
            }

            canvasStoreApi.getState().moveNode(nodeId, origin)
            pendingOrigin.current = null

            // Update drop-target region highlight (single-node drag only).
            // Skip when the node is already a member of the region under it,
            // since "joining" is a no-op in that case.
            {
              const st = canvasStoreApi.getState()
              const draggedNode = st.nodes[nodeId]
              let target: string | null = null
              if (draggedNode) {
                for (const region of Object.values(st.regions)) {
                  const ox = Math.max(
                    0,
                    Math.min(
                      draggedNode.origin.x + draggedNode.size.width,
                      region.origin.x + region.size.width,
                    ) - Math.max(draggedNode.origin.x, region.origin.x),
                  )
                  const oy = Math.max(
                    0,
                    Math.min(
                      draggedNode.origin.y + draggedNode.size.height,
                      region.origin.y + region.size.height,
                    ) - Math.max(draggedNode.origin.y, region.origin.y),
                  )
                  const area = draggedNode.size.width * draggedNode.size.height
                  if (area > 0 && (ox * oy) / area > 0.5) {
                    if (region.id !== draggedNode.regionId) target = region.id
                    break
                  }
                }
              }
              if (st.dropTargetRegionId !== target) {
                canvasStoreApi.setState({ dropTargetRegionId: target })
              }
            }

            // Magnetic snap guides (runs at most once per frame)
            const settings = useSettingsStore.getState()
            if (settings.snapToGridEnabled) {
              const currentState = canvasStoreApi.getState()
              const currentNode2 = currentState.nodes[nodeId]
              if (currentNode2) {
                const idx = snapIndexRef.current
                let neighbors: SnapCandidate[]
                if (idx && idx.cells.size > 0) {
                  const CELL_SIZE = idx.cellSize
                  const seen = new Set<SnapCandidate>()
                  const x0 = Math.floor((currentNode2.origin.x - 8) / CELL_SIZE)
                  const y0 = Math.floor((currentNode2.origin.y - 8) / CELL_SIZE)
                  const x1 = Math.floor((currentNode2.origin.x + currentNode2.size.width + 8) / CELL_SIZE)
                  const y1 = Math.floor((currentNode2.origin.y + currentNode2.size.height + 8) / CELL_SIZE)
                  for (let cx = x0; cx <= x1; cx++) {
                    for (let cy = y0; cy <= y1; cy++) {
                      const bucket = idx.cells.get(`${cx},${cy}`)
                      if (bucket) for (const c of bucket) seen.add(c)
                    }
                  }
                  neighbors = Array.from(seen)
                } else {
                  neighbors = idx ? idx.all : []
                }
                const snapResult = snapToEdges(
                  { origin: currentNode2.origin, size: currentNode2.size },
                  neighbors,
                  8,
                )

                // Apply magnetic snapping with continuous quadratic pull
                // across the full 0–8px range (no dead zones).
                const snapped = snapResult.snappedOrigin
                const dx = Math.abs(snapped.x - currentNode2.origin.x)
                const dy = Math.abs(snapped.y - currentNode2.origin.y)

                const magneticOrigin = { ...currentNode2.origin }
                const axes = { x: false, y: false }

                // X-axis magnetic pull (only if x snapped)
                if (snapResult.lines.some((l) => l.axis === 'x') && dx < 8) {
                  const t = 1 - (dx / 8) ** 2
                  magneticOrigin.x = currentNode2.origin.x + (snapped.x - currentNode2.origin.x) * t
                  axes.x = dx < 6
                }

                // Y-axis magnetic pull (only if y snapped)
                if (snapResult.lines.some((l) => l.axis === 'y') && dy < 8) {
                  const t = 1 - (dy / 8) ** 2
                  magneticOrigin.y = currentNode2.origin.y + (snapped.y - currentNode2.origin.y) * t
                  axes.y = dy < 6
                }

                lastMagneticAxes.current = axes

                if (snapResult.lines.length > 0) {
                  canvasStoreApi.getState().moveNode(nodeId, magneticOrigin)
                }

                currentState.setSnapGuides({ lines: snapResult.lines })
              }
            }
          })
        }
      }

      const handleMouseUp = (ev: MouseEvent) => {
        // --- Handle dock-drag drop ---
        if (inDockDragRef.current) {
          const dockDrag = useDockDragStore.getState()
          // CanvasDropZone already handled this drop — skip our own drop logic
          // (otherwise the source canvas node gets duplicated).
          if (dockDrag.canvasDropConsumed) {
            cancelDrag()
            return
          }
          const target = dockDrag.activeDropTarget
          const panelId = dockDrag.draggedPanelId

          if (target && panelId) {
            // Drop within this window — cancel any cross-window drag
            if (crossWindowRef.current) {
              crossWindowRef.current = null
              window.electronAPI.crossWindowDragCancel()
            }
            // Clean up drag state (cancelDrag will call endDrag since inDockDragRef is still true)
            cancelDrag()
            // Re-resolve hit so we know which DockStore owns the target —
            // this lets a canvas node be dropped into a per-node mini-dock.
            const hit = hitTestDropTargetWithStore(ev.clientX, ev.clientY)
            // Look up the per-node DockStore that currently owns the dragged
            // panel so executeDrop can undock it from the *real* source store
            // (not just finalizeRemoveNode the canvas node). Without this,
            // terminals end up orphaned because the per-node store never
            // releases the xterm element before the canvas node unmounts.
            const sourceNodeStore = findNodeDockStore(nodeId) ?? undefined
            executeDrop(
              panelId,
              { type: 'canvas', nodeId },
              hit?.target ?? target,
              canvasStoreApi,
              hit?.dockStoreApi,
              sourceNodeStore,
            )
          } else if (
            isCursorOutsideWindow(ev.clientX, ev.clientY) &&
            panelId &&
            !(window.electronAPI?.isMainWindowFullscreen?.() ?? false)
          ) {
            // Cursor is outside the window — try cross-window drop first, then fall back to detach
            const cwState = crossWindowRef.current
            crossWindowRef.current = null
            cancelDrag()

            if (cwState) {
              // Ask main process to resolve: did any target window claim the drop?
              window.electronAPI.crossWindowDragResolve().then(async ({ claimed }) => {
                if (claimed) {
                  // Target window accepted — remove panel from canvas
                  canvasStoreApi.getState().finalizeRemoveNode(nodeId)
                  if (cwState.snapshot.panel.type === 'terminal') terminalRegistry.release(panelId)
                } else {
                  // No target — try to detach into a new dock window, but
                  // only REMOVE from the canvas if the main process accepted.
                  // When the main window is fullscreen, dragDetach returns
                  // null and we keep the node in place.
                  const wsId = useAppStore.getState().selectedWorkspaceId
                  const winId = await window.electronAPI.dragDetach(cwState.snapshot, wsId)
                  if (winId != null) {
                    canvasStoreApi.getState().finalizeRemoveNode(nodeId)
                    if (cwState.snapshot.panel.type === 'terminal') terminalRegistry.release(panelId)
                  }
                  // else: detach refused (fullscreen) — leave node where it is.
                }
              })
            } else {
              // No cross-window drag was active — direct detach
              const panel = getPanelForId(panelId)
              const node = canvasStoreApi.getState().nodes[nodeId]
              if (panel && node) {
                const snapshot = createTransferSnapshot(
                  panel,
                  { type: 'canvas', canvasId: '', canvasNodeId: nodeId },
                  { origin: node.origin, size: node.size },
                )
                const wsId = useAppStore.getState().selectedWorkspaceId
                window.electronAPI.dragDetach(snapshot, wsId).then((winId) => {
                  if (winId != null) {
                    canvasStoreApi.getState().finalizeRemoveNode(nodeId)
                    if (panel.type === 'terminal') terminalRegistry.release(panelId)
                  }
                  // else: detach refused — keep node in place.
                })
              }
            }
          } else {
            // No valid drop target — revert position
            cancelDrag(true)
            return
          }
          return
        }

        // Normal drag end — flush position and clean up
        cancelDrag()

        // Snap to grid if enabled — skip axes that were magnetically snapped
        // to avoid a visible jump from magnetic position to grid position.
        const settings = useSettingsStore.getState()
        if (settings.snapToGridEnabled) {
          const skipAxes = lastMagneticAxes.current
          if (skipAxes.x || skipAxes.y) {
            snapNodeToGridSelective(canvasStoreApi, nodeId, settings.gridSpacing, true, skipAxes)
          } else {
            snapNodeToGrid(canvasStoreApi, nodeId, settings.gridSpacing, true)
          }
          lastMagneticAxes.current = { x: false, y: false }
        }

        // Clear drop-target highlight
        if (canvasStoreApi.getState().dropTargetRegionId !== null) {
          canvasStoreApi.setState({ dropTargetRegionId: null })
        }

        // Containment detection: assign/remove regionId for single-node drags
        const finalState = canvasStoreApi.getState()
        const isMulti =
          finalState.selectedNodeIds.size > 1 || finalState.selectedRegionIds.size > 0
        if (!isMulti) {
          const draggedNode = finalState.nodes[nodeId]
          if (draggedNode) {
            let bestRegion: string | undefined
            for (const region of Object.values(finalState.regions)) {
              const overlapX = Math.max(
                0,
                Math.min(
                  draggedNode.origin.x + draggedNode.size.width,
                  region.origin.x + region.size.width,
                ) - Math.max(draggedNode.origin.x, region.origin.x),
              )
              const overlapY = Math.max(
                0,
                Math.min(
                  draggedNode.origin.y + draggedNode.size.height,
                  region.origin.y + region.size.height,
                ) - Math.max(draggedNode.origin.y, region.origin.y),
              )
              const overlapArea = overlapX * overlapY
              const nodeArea = draggedNode.size.width * draggedNode.size.height
              if (nodeArea > 0 && overlapArea / nodeArea > 0.5) {
                bestRegion = region.id
                break
              }
            }
            if (bestRegion !== draggedNode.regionId) {
              finalState.setNodeRegion(nodeId, bestRegion)
            }
          }
        }
      }

      // Cancel drag on window blur (e.g. Cmd+Tab, clicking another app)
      // — the OS won't deliver mouseup in these cases
      const handleBlur = () => {
        if (isDraggingRef.current) {
          cancelDrag(true)
        }
      }

      const controller = new AbortController()
      abortRef.current = controller
      window.addEventListener('mousemove', handleMouseMove, { signal: controller.signal })
      window.addEventListener('mouseup', handleMouseUp, { signal: controller.signal })
      window.addEventListener('blur', handleBlur, { signal: controller.signal })
    },
    [nodeId, zoomLevel, cancelDrag],
  )

  return {
    isDragging: isDraggingRef.current,
    wasDragged: wasDraggedRef,
    handleDragStart,
  }
}

// Re-export for existing consumers
export { executeDrop } from '../docking/dropExecution'

// Helper: get panel info from app store
function getPanelForId(panelId: string): import('../../shared/types').PanelState | undefined {
  const state = useAppStore.getState()
  const wsId = state.selectedWorkspaceId
  const ws = state.workspaces.find(w => w.id === wsId)
  return ws?.panels[panelId]
}
