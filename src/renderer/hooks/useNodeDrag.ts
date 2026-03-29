// =============================================================================
// useNodeDrag — drag-to-move hook for canvas nodes.
// Ported from CanvasNode.swift drag logic.
// =============================================================================

import { useCallback, useEffect, useRef } from 'react'
import { useCanvasStore } from '../stores/canvasStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { useDockStore } from '../stores/dockStore'
import { snap, snapToEdges } from '../canvas/layoutEngine'
import type { Point, Rect, DockZonePosition } from '../../shared/types'
import { DOCK_EDGE_TRIGGER_PX } from '../../shared/types'

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

export function useNodeDrag(nodeId: string, zoomLevel: number): UseNodeDragReturn {
  const dragStateRef = useRef<DragState | null>(null)
  const isDraggingRef = useRef(false)
  const dragStartedRef = useRef(false)
  const wasDraggedRef = useRef(false)
  const rafId = useRef<number>(0)
  const pendingOrigin = useRef<Point | null>(null)

  // Cleanup on unmount: ensure interaction class is removed if drag was active
  useEffect(() => {
    return () => {
      if (isDraggingRef.current) {
        document.body.classList.remove('canvas-interacting')
      }
      if (rafId.current) {
        cancelAnimationFrame(rafId.current)
      }
    }
  }, [])

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()

      const node = useCanvasStore.getState().nodes[nodeId]
      if (!node || node.isPinned) return

      // Clear selection when dragging an unselected node
      const preState = useCanvasStore.getState()
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
        }

        // Dock edge detection — check cursor position against viewport edges
        const uiState = useUIStore.getState()
        let dropTarget: DockZonePosition | null = null
        if (ev.clientX < DOCK_EDGE_TRIGGER_PX) {
          dropTarget = 'left'
        } else if (ev.clientX > window.innerWidth - DOCK_EDGE_TRIGGER_PX) {
          dropTarget = 'right'
        } else if (ev.clientY > window.innerHeight - DOCK_EDGE_TRIGGER_PX) {
          dropTarget = 'bottom'
        }
        if (uiState.dockDropTarget !== dropTarget) {
          useUIStore.getState().setDockDropTarget(dropTarget)
        }

        const zoom = useCanvasStore.getState().zoomLevel
        const currentNode = useCanvasStore.getState().nodes[nodeId]
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

            const currentState = useCanvasStore.getState()
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

              // Move all selected nodes individually
              for (const id of currentState.selectedNodeIds) {
                const n = currentState.nodes[id]
                if (n) {
                  useCanvasStore.getState().moveNode(id, {
                    x: n.origin.x + dx,
                    y: n.origin.y + dy,
                  })
                }
              }
              // Move selected regions without cascading to children
              // (contained nodes are already selected and moved above)
              for (const id of currentState.selectedRegionIds) {
                const r = useCanvasStore.getState().regions[id]
                if (r) {
                  useCanvasStore.getState().resizeRegion(id, r.size, {
                    x: r.origin.x + dx,
                    y: r.origin.y + dy,
                  })
                }
              }
              pendingOrigin.current = null
              return // Skip snap guides for multi-drag
            }

            useCanvasStore.getState().moveNode(nodeId, origin)
            pendingOrigin.current = null

            // Magnetic snap guides (runs at most once per frame)
            const settings = useSettingsStore.getState()
            if (settings.snapToGridEnabled) {
              const currentState = useCanvasStore.getState()
              const currentNode2 = currentState.nodes[nodeId]
              if (currentNode2) {
                const neighbors = [
                  ...Object.values(currentState.nodes)
                    .filter((n) => n.id !== nodeId)
                    .map((n) => ({ origin: n.origin, size: n.size })),
                  ...Object.values(currentState.regions)
                    .map((r) => ({ origin: r.origin, size: r.size })),
                ]
                const snapResult = snapToEdges(
                  { origin: currentNode2.origin, size: currentNode2.size },
                  neighbors,
                  8,
                )

                // Apply magnetic snapping:
                //   within 4px  → lock to snap line
                //   4–8px       → interpolate (pull) toward snap line
                if (snapResult.lines.length > 0) {
                  const snapped = snapResult.snappedOrigin
                  const dx = Math.abs(snapped.x - currentNode2.origin.x)
                  const dy = Math.abs(snapped.y - currentNode2.origin.y)

                  const magneticOrigin = { ...currentNode2.origin }

                  // X-axis magnetic pull (only if x snapped)
                  if (snapResult.lines.some((l) => l.axis === 'x')) {
                    if (dx < 4) {
                      magneticOrigin.x = snapped.x
                    } else if (dx < 8) {
                      const t = 1 - (dx - 4) / 4
                      magneticOrigin.x = currentNode2.origin.x + (snapped.x - currentNode2.origin.x) * t
                    }
                  }

                  // Y-axis magnetic pull (only if y snapped)
                  if (snapResult.lines.some((l) => l.axis === 'y')) {
                    if (dy < 4) {
                      magneticOrigin.y = snapped.y
                    } else if (dy < 8) {
                      const t = 1 - (dy - 4) / 4
                      magneticOrigin.y = currentNode2.origin.y + (snapped.y - currentNode2.origin.y) * t
                    }
                  }

                  useCanvasStore.getState().moveNode(nodeId, magneticOrigin)
                }

                currentState.setSnapGuides({ lines: snapResult.lines })
              }
            }
          })
        }
      }

      const handleMouseUp = () => {
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)

        // Check for dock drop
        const dockTarget = useUIStore.getState().dockDropTarget
        if (dockTarget && dragStartedRef.current) {
          const currentNode = useCanvasStore.getState().nodes[nodeId]
          if (currentNode) {
            useDockStore.getState().dockPanel(currentNode.panelId, dockTarget)
            useCanvasStore.getState().removeNode(nodeId)
          }
          useUIStore.getState().setDockDropTarget(null)
          isDraggingRef.current = false
          dragStartedRef.current = false
          document.body.classList.remove('canvas-interacting')
          if (rafId.current) {
            cancelAnimationFrame(rafId.current)
            rafId.current = 0
          }
          pendingOrigin.current = null
          useCanvasStore.getState().clearSnapGuides()
          dragStateRef.current = null
          return // Early return — skip normal drop logic
        }
        useUIStore.getState().setDockDropTarget(null) // Clear indicator even if not docking

        isDraggingRef.current = false
        dragStartedRef.current = false
        document.body.classList.remove('canvas-interacting')

        // Cancel any pending RAF and flush the last position immediately
        if (rafId.current) {
          cancelAnimationFrame(rafId.current)
          rafId.current = 0
        }
        if (pendingOrigin.current) {
          useCanvasStore.getState().moveNode(nodeId, pendingOrigin.current)
          pendingOrigin.current = null
        }

        // Snap to grid if enabled
        const settings = useSettingsStore.getState()
        if (settings.snapToGridEnabled) {
          const state = useCanvasStore.getState()
          const node = state.nodes[nodeId]
          if (node) {
            const nodeRect: Rect = { origin: node.origin, size: node.size }
            const neighbors: Rect[] = [
              ...Object.values(state.nodes)
                .filter((n) => n.id !== nodeId)
                .map((n) => ({ origin: n.origin, size: n.size })),
              ...Object.values(state.regions)
                .map((r) => ({ origin: r.origin, size: r.size })),
            ]

            const snappedOrigin = snap(
              nodeRect,
              neighbors,
              settings.gridSpacing,
              8,
            )
            useCanvasStore.getState().moveNode(nodeId, snappedOrigin)
          }
        }

        // Containment detection: assign/remove regionId for single-node drags
        const finalState = useCanvasStore.getState()
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

        useCanvasStore.getState().clearSnapGuides()
        dragStateRef.current = null
      }

      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
    },
    [nodeId, zoomLevel],
  )

  return {
    isDragging: isDraggingRef.current,
    wasDragged: wasDraggedRef,
    handleDragStart,
  }
}
