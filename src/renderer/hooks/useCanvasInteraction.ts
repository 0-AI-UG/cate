// =============================================================================
// useCanvasInteraction — custom hook for canvas pan/zoom interaction.
// Ported from CanvasView.swift scroll/zoom/right-click-drag handlers.
// =============================================================================

import { useCallback, useRef, useState, useEffect } from 'react'
import type { StoreApi } from 'zustand'
import type { CanvasStore } from '../stores/canvasStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore, effectiveCanvasTool } from '../stores/uiStore'
import { useDragStore } from '../drag'
import { viewToCanvas } from '../lib/canvas/coordinates'
import { isMouseWheel, type WheelLike } from '../lib/wheelIntent'
import { ZOOM_MIN, ZOOM_MAX } from '../../shared/types'
import type { Point } from '../../shared/types'

// How many pixels the mouse must move before a right-click becomes a drag
const RIGHT_CLICK_DRAG_THRESHOLD = 4

// Fraction of the current zoom that one physical mouse-wheel notch changes it
// by (before the zoom-speed multiplier). Proportional so a notch feels the same
// at any zoom level; a discrete notch can't use the delta-proportional path the
// trackpad pinch uses.
const MOUSE_WHEEL_ZOOM_FACTOR = 0.15

// AABB overlap test for marquee selection
function rectsIntersect(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): boolean {
  return !(ax + aw <= bx || bx + bw <= ax || ay + ah <= by || by + bh <= ay)
}

// CSS cursor for the canvas when idle (not actively panning), per active tool.
function idleCursorForTool(): string {
  return effectiveCanvasTool(useUIStore.getState()) === 'hand' ? 'grab' : ''
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
  canvasStoreApi: StoreApi<CanvasStore>,
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
  // Wheel-pan canvas-interacting class management
  // We add the class when a wheel pan starts and remove it after the wheel goes quiet.
  const wheelPanActive = useRef(false)
  const wheelPanEndTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [canvasContextMenu, setCanvasContextMenu] =
    useState<CanvasContextMenuState | null>(null)

  const closeCanvasContextMenu = useCallback(() => {
    setCanvasContextMenu(null)
  }, [])

  // Helper — fully stop any in-flight zoom/pan animations and reset interaction
  // refs. Called on unmount AND when a dock-drag begins, so canvas state can't
  // continue mutating while the user is repositioning a panel via docking.
  const cancelAllAnimations = useCallback(() => {
    if (cancelInertia.current) {
      cancelInertia.current()
      cancelInertia.current = null
    }
    if (zoomRafId.current) {
      cancelAnimationFrame(zoomRafId.current)
      zoomRafId.current = 0
    }
    targetZoom.current = null
    if (panRafId.current) {
      cancelAnimationFrame(panRafId.current)
      panRafId.current = 0
    }
    pendingPanDelta.current = { x: 0, y: 0 }
    if (wheelPanEndTimer.current) {
      clearTimeout(wheelPanEndTimer.current)
      wheelPanEndTimer.current = null
    }
    if (wheelPanActive.current) {
      document.body.classList.remove('canvas-interacting')
      wheelPanActive.current = false
    }
    // Also stop the canvas store's own animateZoomTo rAF — it lives in a
    // module-level variable inside canvasStore.ts (not in this hook's refs),
    // so cancelling our local zoom rAF doesn't reach it. If a toolbar zoom or
    // keyboard shortcut kicked it off and a dock-drag begins mid-flight,
    // the world transform would keep scaling and the dimmed source would
    // appear to "scale with movement" even though nothing's resizing it.
    canvasStoreApi.getState().cancelZoomAnimation()
  }, [canvasStoreApi])

  // Cancel animations on unmount to avoid memory leaks
  useEffect(() => {
    return cancelAllAnimations
  }, [cancelAllAnimations])

  // When a dock-aware drag begins, immediately stop any zoom/pan momentum so
  // the canvas isn't simultaneously moving + the user is dragging a tab.
  // Subscribed on the store so the rAF/timer state is killed at the moment
  // `isDragging` transitions to true, not on a re-render.
  useEffect(() => {
    let prev = useDragStore.getState().isDragging
    return useDragStore.subscribe((s) => {
      if (s.isDragging && !prev) cancelAllAnimations()
      prev = s.isDragging
    })
  }, [cancelAllAnimations])

  // ---------------------------------------------------------------------------
  // Smooth zoom animation — interpolates zoomLevel toward targetZoom each frame
  // ---------------------------------------------------------------------------

  const smoothZoomTick = useCallback(() => {
    if (targetZoom.current === null) return

    const state = canvasStoreApi.getState()
    const current = state.zoomLevel
    const target = targetZoom.current

    const diff = target - current
    if (Math.abs(diff) < 0.001) {
      // Close enough — snap to target
      const canvasPoint = viewToCanvas(cursorViewPoint.current, current, state.viewportOffset)
      canvasStoreApi.getState().setZoomAndOffset(target, {
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
    canvasStoreApi.getState().setZoomAndOffset(newZoom, {
      x: cursorViewPoint.current.x - canvasPoint.x * newZoom,
      y: cursorViewPoint.current.y - canvasPoint.y * newZoom,
    })

    zoomRafId.current = requestAnimationFrame(smoothZoomTick)
  }, [])

  // ---------------------------------------------------------------------------
  // Wheel zoom — anchored at the cursor. Called for explicit zoom intent
  // (Cmd/Ctrl+scroll, trackpad pinch) and for plain physical mouse-wheel notches
  // over empty canvas / unfocused panels.
  // ---------------------------------------------------------------------------

  const applyWheelZoom = useCallback(
    (e: React.WheelEvent<HTMLDivElement>, mouse: boolean) => {
      e.preventDefault()
      e.stopPropagation()

      // Cancel any inertia / toolbar zoom animation when a zoom starts
      if (cancelInertia.current) {
        cancelInertia.current()
        cancelInertia.current = null
      }
      canvasStoreApi.getState().cancelZoomAnimation()

      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) return

      // Anchor the zoom at the cursor
      cursorViewPoint.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      }

      const { zoomLevel } = canvasStoreApi.getState()
      const { zoomSpeed } = useSettingsStore.getState()
      // Accumulate from the in-flight target (or live zoom if idle) so rapid
      // input keeps building toward a single smooth destination.
      const base = targetZoom.current ?? zoomLevel
      const next = mouse
        // Discrete notch: proportional step so it feels consistent at any zoom.
        ? base * (1 + Math.sign(-e.deltaY) * MOUSE_WHEEL_ZOOM_FACTOR * zoomSpeed)
        // Continuous gesture (pinch / Cmd+trackpad-scroll): delta-proportional.
        : base + -e.deltaY * 0.01 * zoomSpeed

      targetZoom.current = Math.min(Math.max(next, ZOOM_MIN), ZOOM_MAX)

      if (!zoomRafId.current) {
        zoomRafId.current = requestAnimationFrame(smoothZoomTick)
      }
    },
    [canvasRef, smoothZoomTick],
  )

  // ---------------------------------------------------------------------------
  // Wheel: zoom (Cmd/Ctrl, pinch, or mouse-wheel) vs pan (trackpad two-finger).
  // ---------------------------------------------------------------------------

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      // When a dock-drag is active, swallow wheel input. Trackpad gestures
      // commonly fire alongside a mouse drag and would otherwise zoom/pan the
      // canvas mid-drag, causing the ghost to misalign and the drop to land
      // far from the cursor.
      if (useDragStore.getState().isDragging) {
        e.preventDefault()
        return
      }
      const target = e.target as HTMLElement
      // `handleWheel` is wired via a native `wheel` listener in Canvas.tsx (cast
      // to React's type), so `e` carries Chromium's `wheelDeltaY` at runtime.
      const mouse = isMouseWheel(e as unknown as WheelLike)

      // --- Explicit zoom intent: trackpad pinch (ctrlKey) or Cmd+scroll ---
      // Handled FIRST so it zooms the canvas no matter what's under the cursor —
      // a focused editor, terminal, or browser panel included. macOS delivers a
      // trackpad pinch as a wheel event with ctrlKey set, so this one rule covers
      // both the pinch gesture and the explicit Cmd/Ctrl+scroll.
      if (e.metaKey || e.ctrlKey) {
        applyWheelZoom(e, mouse)
        return
      }

      // --- Plain scroll over a FOCUSED panel: let it scroll its own content ---
      // This takes priority over mouse-wheel zoom so a mouse user can still
      // scroll code in an editor or scrollback in a terminal. Zooming over a
      // focused panel needs the explicit Cmd/Ctrl modifier handled above.

      // Browser panels (webview) route their own wheel via Electron's
      // cross-process input; the passive:false capture listener interferes with
      // that routing, so bail out for any plain wheel over a focused webview.
      if (target.tagName === 'WEBVIEW') {
        const nodeEl = target.closest('[data-node-id]')
        const nodeId = nodeEl?.getAttribute('data-node-id')
        const { focusedNodeId } = canvasStoreApi.getState()
        if (nodeId && nodeId === focusedNodeId) {
          return
        }
      }

      // Sticky-note content scrolls natively when it can scroll in the wheel's
      // primary direction (annotations aren't canvas nodes).
      const annotationContent = target.closest?.('[data-annotation-content]') as HTMLElement | null
      if (annotationContent) {
        const isHorizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY)
        const canScroll = isHorizontal
          ? annotationContent.scrollWidth > annotationContent.clientWidth
          : annotationContent.scrollHeight > annotationContent.clientHeight
        if (canScroll) return
      }

      const panelContent = target.closest?.('[data-panel-content]')
      if (panelContent) {
        const nodeEl = panelContent.closest('[data-node-id]')
        const nodeId = nodeEl?.getAttribute('data-node-id')
        const { focusedNodeId } = canvasStoreApi.getState()
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
          // No horizontal scrollability — fall through to canvas pan/zoom
        }
      }

      // --- Scroll over empty canvas / unfocused panel: tool decides ---
      // In the Select (click) tool, a plain scroll zooms — for both a physical
      // mouse wheel and a trackpad two-finger scroll (Miro-style). In the Hand
      // (drag) tool, or while Space is held, it falls through to the pan path
      // below instead. The `mouse` flag only picks the zoom feel: discrete
      // notch vs. continuous delta-proportional.
      if (effectiveCanvasTool(useUIStore.getState()) !== 'hand') {
        applyWheelZoom(e, mouse)
        return
      }

      // --- Hand tool: scroll pans the canvas ---
      // Apply canvas-interacting class so iframes/webviews/monaco/xterm don't
      // eat hit-testing while panning. Remove it ~150ms after the wheel goes quiet.
      e.stopPropagation()
      if (!wheelPanActive.current) {
        wheelPanActive.current = true
        document.body.classList.add('canvas-interacting')
      }
      if (wheelPanEndTimer.current) clearTimeout(wheelPanEndTimer.current)
      wheelPanEndTimer.current = setTimeout(() => {
        wheelPanEndTimer.current = null
        wheelPanActive.current = false
        document.body.classList.remove('canvas-interacting')
      }, 150)

      pendingPanDelta.current.x += e.deltaX
      pendingPanDelta.current.y += e.deltaY
      if (!panRafId.current) {
        panRafId.current = requestAnimationFrame(() => {
          panRafId.current = 0
          const dx = pendingPanDelta.current.x
          const dy = pendingPanDelta.current.y
          pendingPanDelta.current.x = 0
          pendingPanDelta.current.y = 0
          const { viewportOffset: vo, setViewportOffset: setVO } = canvasStoreApi.getState()
          setVO({ x: vo.x - dx, y: vo.y - dy })
        })
      }
    },
    [canvasRef, applyWheelZoom],
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
        // During deferred ghost placement: a left-click that misses every ghost
        // cancels placement (same as Esc), as long as free mode isn't armed —
        // armed mode owns its own full-canvas surface and commits on click.
        // Handled here on mousedown because empty canvas background never reaches
        // the 1x1 world div that hosts the click-to-cancel fallback.
        const placement = canvasStoreApi.getState().pendingPlacement
        if (placement && !placement.freeArmed) {
          const t = e.target as HTMLElement
          if (!t.closest('[data-ghost-candidate]') && !t.closest('[data-placement-surface]')) {
            canvasStoreApi.getState().cancelPlacement()
            e.preventDefault()
            return
          }
        }

        // Hand tool (or Space-hold): left-drag pans the canvas, even when the
        // press lands on a node (nodes let the event bubble here under Hand).
        // No context menu, no inertia, no marquee — just a straight pan.
        if (effectiveCanvasTool(useUIStore.getState()) === 'hand') {
          if (cancelInertia.current) {
            cancelInertia.current()
            cancelInertia.current = null
          }
          isPanning.current = true
          panButton.current = 0
          lastPanPos.current = { x: e.clientX, y: e.clientY }
          if (canvasRef.current) {
            canvasRef.current.style.cursor = 'grabbing'
          }
          document.body.classList.add('canvas-interacting')
          e.preventDefault()
          return
        }

        // Left-click on canvas background (not on a node) => marquee selection or clear
        const target = e.target as HTMLElement
        const isOnNode = target.closest('[data-node-id]') !== null
        if (!isOnNode) {
          const rect = canvasRef.current?.getBoundingClientRect()
          if (!rect) return
          const { zoomLevel, viewportOffset } = canvasStoreApi.getState()
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
              const { zoomLevel: z, viewportOffset: vo } = canvasStoreApi.getState()
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

          const cleanupMarquee = () => {
            window.removeEventListener('mousemove', handleMarqueeMove)
            window.removeEventListener('mouseup', handleMarqueeUp)
            window.removeEventListener('blur', handleMarqueeBlur)
          }

          const handleMarqueeBlur = () => {
            cleanupMarquee()
            useUIStore.getState().setMarquee(null)
          }

          const handleMarqueeUp = (ev: MouseEvent) => {
            cleanupMarquee()
            useUIStore.getState().setMarquee(null)

            if (!didDrag) {
              canvasStoreApi.getState().clearSelection()
              canvasStoreApi.getState().unfocus()
              return
            }

            // Compute final marquee rect in canvas-space
            const { zoomLevel: z, viewportOffset: vo } = canvasStoreApi.getState()
            const r = canvasRef.current?.getBoundingClientRect()
            if (!r) return
            const endCanvasX = (ev.clientX - r.left - vo.x) / z
            const endCanvasY = (ev.clientY - r.top - vo.y) / z
            const mx = Math.min(startCanvasX, endCanvasX)
            const my = Math.min(startCanvasY, endCanvasY)
            const mw = Math.abs(endCanvasX - startCanvasX)
            const mh = Math.abs(endCanvasY - startCanvasY)

            const { nodes } = canvasStoreApi.getState()

            const hitNodeIds = Object.values(nodes)
              .filter((n) => rectsIntersect(mx, my, mw, mh, n.origin.x, n.origin.y, n.size.width, n.size.height))
              .map((n) => n.id)

            if (!shiftHeld) {
              canvasStoreApi.getState().clearSelection()
            }
            canvasStoreApi.getState().selectNodes(hitNodeIds, true)
          }

          window.addEventListener('mousemove', handleMarqueeMove)
          window.addEventListener('mouseup', handleMarqueeUp)
          window.addEventListener('blur', handleMarqueeBlur)
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
        canvasStoreApi.getState()

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
          const isOnInteractive = target.closest('[data-node-id]') !== null || target.closest('[data-annotation-id]') !== null
          if (!isOnInteractive) {
            const rect = canvasRef.current?.getBoundingClientRect()
            if (rect) {
              const viewPoint = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top,
              }
              const { zoomLevel, viewportOffset } = canvasStoreApi.getState()
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
          // Hand back to React's idle cursor for the now-effective tool (Space
          // may have been released mid-pan, reverting to the underlying tool).
          canvasRef.current.style.cursor = idleCursorForTool()
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

                const { viewportOffset, setViewportOffset } = canvasStoreApi.getState()
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
