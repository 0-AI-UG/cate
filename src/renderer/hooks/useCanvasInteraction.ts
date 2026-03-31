// =============================================================================
// useCanvasInteraction — custom hook for canvas pan/zoom interaction.
// Ported from CanvasView.swift scroll/zoom/right-click-drag handlers.
// =============================================================================

import { useCallback, useRef, useState, useEffect } from 'react'
import { useCanvasStore, cancelZoomAnimation } from '../stores/canvasStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { viewToCanvas } from '../lib/coordinates'
import { ZOOM_MIN, ZOOM_MAX } from '../../shared/types'
import type { Point } from '../../shared/types'

// How many pixels the mouse must move before a right-click becomes a drag
const RIGHT_CLICK_DRAG_THRESHOLD = 4

// AABB overlap test for marquee selection
function rectsIntersect(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): boolean {
  return !(ax + aw <= bx || bx + bw <= ax || ay + ah <= by || by + bh <= ay)
}

export interface CanvasContextMenuState {
  x: number       // screen X for the menu
  y: number       // screen Y for the menu
  canvasPoint: Point  // canvas-space coords where new panels should be created
}

interface CanvasInteractionHandlers {
  handleWheel: (e: React.WheelEvent<HTMLDivElement>) => void
  handleMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void
  handleMouseMove: (e: React.MouseEvent<HTMLDivElement>) => void
  handleMouseUp: (e: React.MouseEvent<HTMLDivElement>) => void
  handleContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void
  canvasContextMenu: CanvasContextMenuState | null
  closeCanvasContextMenu: () => void
}

export function useCanvasInteraction(
  canvasRef: React.RefObject<HTMLDivElement | null>,
): CanvasInteractionHandlers {
  const isPanning = useRef(false)
  const lastPanPos = useRef<{ x: number; y: number } | null>(null)
  const panButton = useRef<number | null>(null)

  // Right-click drag detection
  const rightClickStart = useRef<{ x: number; y: number } | null>(null)
  const rightClickDidDrag = useRef(false)

  // Momentum/inertia panning — circular buffer avoids shift() on every mousemove
  const velocityBuffer = useRef<Array<{ dx: number; dy: number; time: number }>>(new Array(5))
  const velocityIndex = useRef(0)
  const velocityCount = useRef(0)
  const cancelInertia = useRef<(() => void) | null>(null)

  // Smooth zoom refs
  const targetZoom = useRef<number | null>(null)
  const zoomRafId = useRef<number>(0)
  const cursorViewPoint = useRef<{ x: number; y: number }>({ x: 0, y: 0 })

  // Wheel-pan throttle refs
  const panRafId = useRef<number>(0)
  const pendingPanDelta = useRef<{ x: number; y: number }>({ x: 0, y: 0 })

  const [canvasContextMenu, setCanvasContextMenu] =
    useState<CanvasContextMenuState | null>(null)

  const closeCanvasContextMenu = useCallback(() => {
    setCanvasContextMenu(null)
  }, [])

  // Cancel animations on unmount to avoid memory leaks
  useEffect(() => {
    return () => {
      if (cancelInertia.current) {
        cancelInertia.current()
        cancelInertia.current = null
      }
      if (zoomRafId.current) {
        cancelAnimationFrame(zoomRafId.current)
        zoomRafId.current = 0
      }
      if (panRafId.current) {
        cancelAnimationFrame(panRafId.current)
        panRafId.current = 0
      }
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Smooth zoom animation — interpolates zoomLevel toward targetZoom each frame
  // ---------------------------------------------------------------------------

  const smoothZoomTick = useCallback(() => {
    if (targetZoom.current === null) return

    const state = useCanvasStore.getState()
    const current = state.zoomLevel
    const target = targetZoom.current

    const diff = target - current
    if (Math.abs(diff) < 0.001) {
      // Close enough — snap to target
      const canvasPoint = viewToCanvas(cursorViewPoint.current, current, state.viewportOffset)
      useCanvasStore.getState().setZoomAndOffset(target, {
        x: cursorViewPoint.current.x - canvasPoint.x * target,
        y: cursorViewPoint.current.y - canvasPoint.y * target,
      })
      targetZoom.current = null
      zoomRafId.current = 0
      return
    }

    // Lerp toward target (0.15 per 16.67ms frame equivalent)
    const newZoom = current + diff * 0.15
    const canvasPoint = viewToCanvas(cursorViewPoint.current, current, state.viewportOffset)
    useCanvasStore.getState().setZoomAndOffset(newZoom, {
      x: cursorViewPoint.current.x - canvasPoint.x * newZoom,
      y: cursorViewPoint.current.y - canvasPoint.y * newZoom,
    })

    zoomRafId.current = requestAnimationFrame(smoothZoomTick)
  }, [])

  // ---------------------------------------------------------------------------
  // Wheel: Cmd+scroll = zoom around cursor, otherwise pan
  // ---------------------------------------------------------------------------

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      // If the scroll originated inside a focused panel's content area,
      // let the panel handle it — but only if the panel can scroll in that direction.
      // Horizontal swipes should pan the canvas when the panel has no horizontal scroll.
      const target = e.target as HTMLElement
      const panelContent = target.closest?.('[data-panel-content]')
      if (panelContent) {
        const nodeEl = panelContent.closest('[data-node-id]')
        const nodeId = nodeEl?.getAttribute('data-node-id')
        const { focusedNodeId } = useCanvasStore.getState()
        if (nodeId && nodeId === focusedNodeId) {
          const isHorizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY)
          if (!isHorizontal) {
            return // Vertical scroll — panel handles it
          }
          // Check if any element between target and panel boundary can scroll horizontally
          let el: HTMLElement | null = target
          while (el && el !== panelContent) {
            if (el.scrollWidth > el.clientWidth) {
              return // Panel has horizontal scroll — let it handle it
            }
            el = el.parentElement
          }
          // No horizontal scrollability — fall through to canvas pan
        }
      }

      e.stopPropagation()

      const { zoomLevel, viewportOffset, setViewportOffset } =
        useCanvasStore.getState()
      const { zoomSpeed } = useSettingsStore.getState()

      if (e.metaKey || e.ctrlKey) {
        e.preventDefault() // Only prevent default for zoom, not pan

        // Cancel any inertia when a zoom starts
        if (cancelInertia.current) {
          cancelInertia.current()
          cancelInertia.current = null
        }

        // Cancel any toolbar animateZoomTo animation
        cancelZoomAnimation()

        const rect = canvasRef.current?.getBoundingClientRect()
        if (!rect) return

        // Update cursor position for the animation
        cursorViewPoint.current = {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        }

        const scrollDelta = -e.deltaY
        const zoomDelta = scrollDelta * 0.01 * zoomSpeed

        // Accumulate target zoom from current target (or live zoom if idle)
        targetZoom.current = Math.min(
          Math.max(
            (targetZoom.current ?? zoomLevel) + zoomDelta,
            ZOOM_MIN,
          ),
          ZOOM_MAX,
        )

        // Start animation loop if not already running
        if (!zoomRafId.current) {
          zoomRafId.current = requestAnimationFrame(smoothZoomTick)
        }
      } else {
        // Two-finger scroll = pan — accumulate deltas and apply once per frame
        pendingPanDelta.current.x += e.deltaX
        pendingPanDelta.current.y += e.deltaY
        if (!panRafId.current) {
          panRafId.current = requestAnimationFrame(() => {
            panRafId.current = 0
            const dx = pendingPanDelta.current.x
            const dy = pendingPanDelta.current.y
            pendingPanDelta.current.x = 0
            pendingPanDelta.current.y = 0
            const { viewportOffset: vo, setViewportOffset: setVO } = useCanvasStore.getState()
            setVO({ x: vo.x - dx, y: vo.y - dy })
          })
        }
      }
    },
    [canvasRef, smoothZoomTick],
  )

  // ---------------------------------------------------------------------------
  // Mouse: right-click drag for panning, left-click on background to unfocus
  // ---------------------------------------------------------------------------

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.button === 2 || e.button === 1) {
        // Cancel any running inertia before starting a new drag
        if (cancelInertia.current) {
          cancelInertia.current()
          cancelInertia.current = null
        }
        isPanning.current = true
        panButton.current = e.button
        lastPanPos.current = { x: e.clientX, y: e.clientY }
        // Only track right-click for context menu
        if (e.button === 2) {
          rightClickStart.current = { x: e.clientX, y: e.clientY }
          rightClickDidDrag.current = false
          velocityIndex.current = 0
          velocityCount.current = 0
        }
        if (canvasRef.current) {
          canvasRef.current.style.cursor = 'grabbing'
        }
        document.body.classList.add('canvas-interacting')
        e.preventDefault()
      } else if (e.button === 0) {
        // Left-click on canvas background (not on a node/region) => marquee selection or clear
        const target = e.target as HTMLElement
        const isOnNode = target.closest('[data-node-id]') !== null
        const isOnRegion = target.closest('[data-region-id]') !== null
        if (!isOnNode && !isOnRegion) {
          const rect = canvasRef.current?.getBoundingClientRect()
          if (!rect) return
          const { zoomLevel, viewportOffset } = useCanvasStore.getState()
          const startCanvasX = (e.clientX - rect.left - viewportOffset.x) / zoomLevel
          const startCanvasY = (e.clientY - rect.top - viewportOffset.y) / zoomLevel

          const startClientX = e.clientX
          const startClientY = e.clientY
          const shiftHeld = e.shiftKey

          let didDrag = false

          const handleMarqueeMove = (ev: MouseEvent) => {
            const dx = ev.clientX - startClientX
            const dy = ev.clientY - startClientY
            if (!didDrag && Math.sqrt(dx * dx + dy * dy) >= 4) {
              didDrag = true
            }
            if (didDrag) {
              const { zoomLevel: z, viewportOffset: vo } = useCanvasStore.getState()
              const r = canvasRef.current?.getBoundingClientRect()
              if (!r) return
              const currentCanvasX = (ev.clientX - r.left - vo.x) / z
              const currentCanvasY = (ev.clientY - r.top - vo.y) / z
              useUIStore.getState().setMarquee({
                startX: startCanvasX,
                startY: startCanvasY,
                currentX: currentCanvasX,
                currentY: currentCanvasY,
              })
            }
          }

          const handleMarqueeUp = (ev: MouseEvent) => {
            window.removeEventListener('mousemove', handleMarqueeMove)
            window.removeEventListener('mouseup', handleMarqueeUp)
            useUIStore.getState().setMarquee(null)

            if (!didDrag) {
              useCanvasStore.getState().clearSelection()
              useCanvasStore.getState().unfocus()
              return
            }

            // Compute final marquee rect in canvas-space
            const { zoomLevel: z, viewportOffset: vo } = useCanvasStore.getState()
            const r = canvasRef.current?.getBoundingClientRect()
            if (!r) return
            const endCanvasX = (ev.clientX - r.left - vo.x) / z
            const endCanvasY = (ev.clientY - r.top - vo.y) / z
            const mx = Math.min(startCanvasX, endCanvasX)
            const my = Math.min(startCanvasY, endCanvasY)
            const mw = Math.abs(endCanvasX - startCanvasX)
            const mh = Math.abs(endCanvasY - startCanvasY)

            const { nodes, regions } = useCanvasStore.getState()

            const hitNodeIds = Object.values(nodes)
              .filter((n) => rectsIntersect(mx, my, mw, mh, n.origin.x, n.origin.y, n.size.width, n.size.height))
              .map((n) => n.id)

            const hitRegionIds = Object.values(regions)
              .filter((rg) => rectsIntersect(mx, my, mw, mh, rg.origin.x, rg.origin.y, rg.size.width, rg.size.height))
              .map((rg) => rg.id)

            // Must select both atomically — selectRegions overwrites selectedNodeIds
            if (!shiftHeld) {
              useCanvasStore.getState().clearSelection()
            }
            useCanvasStore.getState().selectNodes(hitNodeIds, true)
            useCanvasStore.getState().selectRegions(hitRegionIds, true)
          }

          window.addEventListener('mousemove', handleMarqueeMove)
          window.addEventListener('mouseup', handleMarqueeUp)
        }
      }
    },
    [canvasRef],
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isPanning.current || !lastPanPos.current) return

      // Check if the right-click has moved far enough to count as a drag
      if (!rightClickDidDrag.current && rightClickStart.current) {
        const dx = e.clientX - rightClickStart.current.x
        const dy = e.clientY - rightClickStart.current.y
        if (Math.sqrt(dx * dx + dy * dy) > RIGHT_CLICK_DRAG_THRESHOLD) {
          rightClickDidDrag.current = true
        }
      }

      const dx = e.clientX - lastPanPos.current.x
      const dy = e.clientY - lastPanPos.current.y

      const { viewportOffset, setViewportOffset } =
        useCanvasStore.getState()

      setViewportOffset({
        x: viewportOffset.x + dx,
        y: viewportOffset.y + dy,
      })

      lastPanPos.current = { x: e.clientX, y: e.clientY }

      // Record velocity sample for right-click drag inertia (circular buffer)
      if (panButton.current === 2) {
        velocityBuffer.current[velocityIndex.current] = { dx, dy, time: performance.now() }
        velocityIndex.current = (velocityIndex.current + 1) % 5
        if (velocityCount.current < 5) velocityCount.current++
      }
    },
    [],
  )

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.button === 2) {
        // If the right-click never dragged, show the canvas background context menu
        // — but only if the click landed on empty canvas (not on a node).
        if (!rightClickDidDrag.current && rightClickStart.current) {
          const target = e.target as HTMLElement
          const isOnInteractive = target.closest('[data-node-id]') !== null || target.closest('[data-region-id]') !== null || target.closest('[data-annotation-id]') !== null
          if (!isOnInteractive) {
            const rect = canvasRef.current?.getBoundingClientRect()
            if (rect) {
              const viewPoint = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top,
              }
              const { zoomLevel, viewportOffset } = useCanvasStore.getState()
              const canvasPoint = viewToCanvas(viewPoint, zoomLevel, viewportOffset)
              setCanvasContextMenu({
                x: e.clientX,
                y: e.clientY,
                canvasPoint,
              })
            }
          }
        }
      }

      if (e.button === 2 || e.button === panButton.current) {
        isPanning.current = false
        panButton.current = null
        lastPanPos.current = null
        rightClickStart.current = null
        if (canvasRef.current) {
          canvasRef.current.style.cursor = ''
        }
        document.body.classList.remove('canvas-interacting')
      }

      // Start inertia after right-click drag release
      if (e.button === 2) {
        // Cancel any previously running inertia
        if (cancelInertia.current) {
          cancelInertia.current()
          cancelInertia.current = null
        }

        if (rightClickDidDrag.current && velocityCount.current >= 2) {
          // Read last 3 samples from circular buffer
          const now = performance.now()
          const recent: Array<{ dx: number; dy: number; time: number }> = []
          for (let i = 0; i < Math.min(3, velocityCount.current); i++) {
            const idx = (velocityIndex.current - 1 - i + 5) % 5
            recent.push(velocityBuffer.current[idx])
          }

          // Only use samples from the last 100ms
          const validSamples = recent.filter(s => now - s.time < 100)

          if (validSamples.length >= 2) {
            const avgDx = validSamples.reduce((sum, s) => sum + s.dx, 0) / validSamples.length
            const avgDy = validSamples.reduce((sum, s) => sum + s.dy, 0) / validSamples.length

            const speed = Math.hypot(avgDx, avgDy)
            if (speed > 2) {
              let velX = avgDx
              let velY = avgDy
              let lastTime = performance.now()
              const startTime = lastTime
              let rafId = 0

              const tick = () => {
                const now = performance.now()
                const dt = Math.min(now - lastTime, 32)
                lastTime = now

                // Frame-rate independent decay
                const factor = Math.pow(0.95, dt / 16.67)
                velX *= factor
                velY *= factor

                // Stop on low velocity or after 500ms max
                if ((Math.abs(velX) < 0.5 && Math.abs(velY) < 0.5) || now - startTime > 500) {
                  cancelInertia.current = null
                  return
                }

                const { viewportOffset, setViewportOffset } = useCanvasStore.getState()
                const scale = dt / 16.67
                setViewportOffset({
                  x: viewportOffset.x + velX * scale,
                  y: viewportOffset.y + velY * scale,
                })

                rafId = requestAnimationFrame(tick)
              }

              rafId = requestAnimationFrame(tick)
              cancelInertia.current = () => {
                if (rafId) cancelAnimationFrame(rafId)
              }
            }
          }
        }

        velocityIndex.current = 0
        velocityCount.current = 0
      }
    },
    [canvasRef],
  )

  // ---------------------------------------------------------------------------
  // Context menu: suppress the browser default (our custom menu is shown in
  // mouseup above; this just prevents the OS menu from also appearing).
  // ---------------------------------------------------------------------------

  const handleContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault()
    },
    [],
  )

  return {
    handleWheel,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleContextMenu,
    canvasContextMenu,
    closeCanvasContextMenu,
  }
}
