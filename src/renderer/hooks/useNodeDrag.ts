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
import { livePositions } from '../canvas/livePositions'
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
  /** Cached DOM element for the dragged node — mutated directly during drag */
  nodeEl: HTMLElement | null
  /** Cached DOM elements for co-selected nodes during multi-drag */
  selectedEls: Map<string, HTMLElement>
  /** Cached focus-glow sibling element for the dragged node (if any). The glow
   *  is a separate sibling div in the DOM, so it must be moved in lockstep
   *  with the node element during drag — otherwise it lags behind and only
   *  snaps to the final position on drop. */
  glowEl: HTMLElement | null
  /** Cached glow elements for co-selected nodes during multi-drag */
  selectedGlowEls: Map<string, HTMLElement>
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

/** Cursor inside the canvas rect with NO inset. Used at mouseup to decide
 *  whether a release counts as "on the canvas" even if the cursor sits in
 *  the dock-drag arm strip. Without this guard a release inside the canvas
 *  (e.g. on the "Drop into canvas" pill, or just near a canvas edge) can
 *  resolve a stale dock activeDropTarget and call finalizeRemoveNode on the
 *  source node — wiping that node and any connections referencing it. */
function isCursorOverCanvasNoInset(clientX: number, clientY: number, nodeId: string): boolean {
  const canvasEl = getOwningCanvasContainer(nodeId)
  if (!canvasEl) return false
  const rect = canvasEl.getBoundingClientRect()
  return (
    clientX >= rect.left &&
    clientX <= rect.right &&
    clientY >= rect.top &&
    clientY <= rect.bottom
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
  // Last position applied to the DOM during drag — committed to store on mouseup
  const lastDomOrigin = useRef<Point | null>(null)
  // Last DOM positions for all selected nodes during multi-drag
  const lastDomOrigins = useRef<Map<string, Point>>(new Map())
  // Last positions for selected regions during multi-drag (regions have no DOM element)
  const lastRegionOrigins = useRef<Map<string, Point>>(new Map())

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
        // Restore DOM positions for reverted drag
        if (ds.nodeEl) {
          ds.nodeEl.style.left = `${ds.initialOrigin.x}px`
          ds.nodeEl.style.top = `${ds.initialOrigin.y}px`
        }
        if (ds.glowEl) {
          ds.glowEl.style.left = `${ds.initialOrigin.x}px`
          ds.glowEl.style.top = `${ds.initialOrigin.y}px`
        }
        canvasStoreApi.getState().moveNode(nodeId, ds.initialOrigin)
      }
    } else {
      // Flush any remaining pending origin first
      if (pendingOrigin.current) {
        canvasStoreApi.getState().moveNode(nodeId, pendingOrigin.current)
      } else if (lastDomOrigin.current) {
        // Commit the last DOM position to the store
        canvasStoreApi.getState().moveNode(nodeId, lastDomOrigin.current)
      }
      // Commit multi-drag positions (nodes + regions) in one batch
      if (lastDomOrigins.current.size > 0 || lastRegionOrigins.current.size > 0) {
        canvasStoreApi.setState((s) => {
          const updatedNodes = { ...s.nodes }
          for (const [id, origin] of lastDomOrigins.current) {
            const n = s.nodes[id]
            if (n) updatedNodes[id] = { ...n, origin }
          }
          const updatedRegions = { ...s.regions }
          for (const [id, origin] of lastRegionOrigins.current) {
            const r = s.regions[id]
            if (r) updatedRegions[id] = { ...r, origin }
          }
          return { nodes: updatedNodes, regions: updatedRegions }
        })
      }
    }

    pendingOrigin.current = null
    lastDomOrigin.current = null
    lastDomOrigins.current.clear()
    // The store now owns the final positions — drop the live-position cache
    // so subsequent reads come from the (canonical) canvasStore values.
    livePositions.clearAll()
    lastRegionOrigins.current.clear()
    snapIndexRef.current = null
    canvasStoreApi.getState().clearSnapGuides()
    if (canvasStoreApi.getState().dropTargetRegionId !== null) {
      canvasStoreApi.setState({ dropTargetRegionId: null })
    }
    dragStateRef.current = null
  }, [nodeId, canvasStoreApi])

  // Cleanup on unmount — commit the last in-flight position rather than
  // reverting. If the node is unmounted mid-drag (e.g. viewport culling
  // kicks in after a store update), reverting to initialOrigin looks like
  // a snap-back to the user.
  useEffect(() => {
    return () => cancelDrag(false)
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

      // Cache DOM elements for imperative position mutation during drag
      const nodeEl = document.querySelector<HTMLElement>(`[data-node-id="${nodeId}"]`)
      const glowEl = document.querySelector<HTMLElement>(`[data-glow-for="${nodeId}"]`)
      const selectedEls = new Map<string, HTMLElement>()
      const selectedGlowEls = new Map<string, HTMLElement>()
      for (const id of preState.selectedNodeIds) {
        const el = document.querySelector<HTMLElement>(`[data-node-id="${id}"]`)
        if (el) selectedEls.set(id, el)
        const gl = document.querySelector<HTMLElement>(`[data-glow-for="${id}"]`)
        if (gl) selectedGlowEls.set(id, gl)
      }

      dragStateRef.current = {
        lastClientX: e.clientX,
        lastClientY: e.clientY,
        initialClientX: e.clientX,
        initialClientY: e.clientY,
        initialOrigin: { ...node.origin },
        nodeEl,
        selectedEls,
        glowEl,
        selectedGlowEls,
      }
      isDraggingRef.current = true
      dragStartedRef.current = false
      wasDraggedRef.current = false
      inDockDragRef.current = false
      lastDomOrigin.current = null
      lastDomOrigins.current.clear()
      lastRegionOrigins.current.clear()

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
            // Grab offset: where the cursor sits inside the source node's
            // on-screen rect. Lets CanvasDropZone render the ghost 1:1 over
            // the window instead of centering it on the cursor.
            const nodeEl = document.querySelector(
              `[data-node-id="${nodeId}"]`,
            ) as HTMLElement | null
            const nodeRect = nodeEl?.getBoundingClientRect()
            // Normalize to canvas-space (divide by source zoom) so ghost
            // sizing stays correct if the target canvas has a different zoom.
            const srcZoom = canvasStoreApi.getState().zoomLevel || 1
            const grabOffset = nodeRect
              ? {
                  x: (ev.clientX - nodeRect.left) / srcZoom,
                  y: (ev.clientY - nodeRect.top) / srcZoom,
                }
              : null
            useDockDragStore.getState().startDrag(
              draggedPanelId,
              panel?.type ?? 'terminal',
              panel?.title ?? 'Panel',
              { type: 'canvas', nodeId },
              null,
              grabOffset,
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

        ds.lastClientX = ev.clientX
        ds.lastClientY = ev.clientY

        // Compute total delta from drag start (un-snapped), then snap the
        // resulting origin to the grid. Using an incremental delta against a
        // snapped accumulator would repeatedly round sub-grid motion back to
        // the same cell, making the node hard to move (especially upward,
        // where Math.round biases ties toward 0).
        const totalDx = (ev.clientX - ds.initialClientX) / zoom
        const totalDy = (ev.clientY - ds.initialClientY) / zoom
        let nextX = ds.initialOrigin.x + totalDx
        let nextY = ds.initialOrigin.y + totalDy

        const settingsLive = useSettingsStore.getState()
        if (settingsLive.snapToGridEnabled) {
          const g = settingsLive.gridSpacing
          // Symmetric rounding so upward/leftward motion has the same
          // threshold as downward/rightward (JS Math.round biases ties
          // toward +Inf, which makes negative-direction drags feel sticky).
          const snapDelta = (v: number) => Math.sign(v) * Math.round(Math.abs(v) / g) * g
          nextX = ds.initialOrigin.x + snapDelta(totalDx)
          nextY = ds.initialOrigin.y + snapDelta(totalDy)
        }

        pendingOrigin.current = { x: nextX, y: nextY }

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

              // Mutate DOM directly for each selected node — no store update during drag
              const ds = dragStateRef.current
              if (ds) {
                for (const [id, el] of ds.selectedEls) {
                  const n = currentState.nodes[id]
                  if (n) {
                    const newX = n.origin.x + dx
                    const newY = n.origin.y + dy
                    el.style.left = `${newX}px`
                    el.style.top = `${newY}px`
                    const gl = ds.selectedGlowEls.get(id)
                    if (gl) {
                      gl.style.left = `${newX}px`
                      gl.style.top = `${newY}px`
                    }
                    lastDomOrigins.current.set(id, { x: newX, y: newY })
                    // Mirror into livePositions so the SVG connection overlay
                    // (CanvasConnections) can follow the move in real time.
                    livePositions.set(id, newX, newY)
                  }
                }
              }
              // Track region positions (regions have no DOM element — commit on mouseup)
              for (const id of currentState.selectedRegionIds) {
                const r = currentState.regions[id]
                if (r) {
                  // dx/dy is total displacement from drag start (store position never changes during drag)
                  lastRegionOrigins.current.set(id, { x: r.origin.x + dx, y: r.origin.y + dy })
                }
              }
              pendingOrigin.current = null
              return // Skip snap guides for multi-drag
            }

            // Single-node drag: mutate DOM directly instead of calling moveNode
            const ds = dragStateRef.current
            if (ds?.nodeEl) {
              ds.nodeEl.style.left = `${origin.x}px`
              ds.nodeEl.style.top = `${origin.y}px`
            }
            if (ds?.glowEl) {
              ds.glowEl.style.left = `${origin.x}px`
              ds.glowEl.style.top = `${origin.y}px`
            }
            lastDomOrigin.current = origin
            // Mirror to livePositions so connection wires follow the cursor.
            livePositions.set(nodeId, origin.x, origin.y)
            pendingOrigin.current = null

            // Update drop-target region highlight (single-node drag only).
            // Uses pending origin since store position is stale during drag.
            {
              const st = currentState
              const storeNode = st.nodes[nodeId]
              const draggedSize = storeNode?.size
              let target: string | null = null
              if (draggedSize) {
                for (const region of Object.values(st.regions)) {
                  const ox = Math.max(
                    0,
                    Math.min(
                      origin.x + draggedSize.width,
                      region.origin.x + region.size.width,
                    ) - Math.max(origin.x, region.origin.x),
                  )
                  const oy = Math.max(
                    0,
                    Math.min(
                      origin.y + draggedSize.height,
                      region.origin.y + region.size.height,
                    ) - Math.max(origin.y, region.origin.y),
                  )
                  const area = draggedSize.width * draggedSize.height
                  if (area > 0 && (ox * oy) / area > 0.5) {
                    if (storeNode && region.id !== storeNode.regionId) target = region.id
                    break
                  }
                }
              }
              if (st.dropTargetRegionId !== target) {
                canvasStoreApi.setState({ dropTargetRegionId: target })
              }
            }

            // Magnetic snap guides (runs at most once per frame).
            // Uses live drag origin for snap calculations, then applies
            // the result via DOM mutation. pendingOrigin is updated so
            // mouseup commits the snapped position.
            const settings = useSettingsStore.getState()
            if (settings.snapToGridEnabled) {
              const currentState2 = canvasStoreApi.getState()
              const storeNode2 = currentState2.nodes[nodeId]
              if (storeNode2) {
                // Use live drag position, not stale store position
                const liveOrigin = origin
                const idx = snapIndexRef.current
                let neighbors: SnapCandidate[]
                if (idx && idx.cells.size > 0) {
                  const CELL_SIZE = idx.cellSize
                  const seen = new Set<SnapCandidate>()
                  const x0 = Math.floor((liveOrigin.x - 8) / CELL_SIZE)
                  const y0 = Math.floor((liveOrigin.y - 8) / CELL_SIZE)
                  const x1 = Math.floor((liveOrigin.x + storeNode2.size.width + 8) / CELL_SIZE)
                  const y1 = Math.floor((liveOrigin.y + storeNode2.size.height + 8) / CELL_SIZE)
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
                // Only show snap guides when we're actually close to a
                // neighbor edge — no magnetic pull during hold, so the node
                // stays locked 1:1 under the cursor. The hard grid snap on
                // mouseup still runs below.
                const GUIDE_THRESHOLD = 3
                const snapResult = snapToEdges(
                  { origin: liveOrigin, size: storeNode2.size },
                  neighbors,
                  GUIDE_THRESHOLD,
                )
                lastMagneticAxes.current = { x: false, y: false }
                currentState2.setSnapGuides({ lines: snapResult.lines })
              }
            }
          })
        }
      }

      const handleMouseUp = (ev: MouseEvent) => {
        // If the release lands inside the source canvas rect (regardless of
        // dock-drag arm strip), force-exit dock-drag mode and treat this as a
        // normal canvas drag end. Without this, releasing on the canvas with
        // a stale activeDropTarget (resolved during a brief edge-strip excursion)
        // would route through executeDrop → finalizeRemoveNode and delete the
        // dragged node along with every connection that referenced it.
        if (
          inDockDragRef.current &&
          isCursorOverCanvasNoInset(ev.clientX, ev.clientY, nodeId)
        ) {
          inDockDragRef.current = false
          if (crossWindowRef.current) {
            crossWindowRef.current = null
            window.electronAPI.crossWindowDragCancel()
          }
          useDockDragStore.getState().endDrag()
        }

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
