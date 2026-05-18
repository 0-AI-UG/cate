// =============================================================================
// Canvas — the main infinite canvas component.
// Ported from CanvasView.swift.
// =============================================================================

import React, { useRef, useCallback, useEffect, useMemo, useState, createContext, useContext } from 'react'
import { useCanvasStoreContext, useCanvasStoreApi, shallow } from '../stores/CanvasStoreContext'
import { useAppStore } from '../stores/appStore'
import { useCanvasInteraction } from '../hooks/useCanvasInteraction'
import { useAutoFocusLargestVisible } from '../hooks/useAutoFocusLargestVisible'
import { useUIStore } from '../stores/uiStore'
import { registerDropZone } from '../hooks/useDockDrag'
import { viewToCanvas } from '../lib/coordinates'
import CanvasGrid from './CanvasGrid'
import SnapGuides from './SnapGuides'
import CanvasRegionComponent from './CanvasRegionComponent'
import CanvasAnnotationComponent from './CanvasAnnotationComponent'
import CanvasDrawings from './CanvasDrawings'
import type { Point, PanelType } from '../../shared/types'

// Module-level style injection — shared across all Canvas instances
let canvasStyleInjected = false
function injectCanvasInteractingStyle(): void {
  if (canvasStyleInjected) return
  canvasStyleInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .canvas-interacting iframe,
    .canvas-interacting webview,
    .canvas-interacting .monaco-editor,
    .canvas-interacting .xterm,
    .canvas-interacting .xterm-screen,
    .canvas-interacting .xterm-helper-textarea {
      pointer-events: none !important;
    }
    .canvas-interacting .xterm,
    .canvas-interacting .xterm * {
      cursor: grabbing !important;
    }
    /* Phase 2.4 — viewport culling: when a canvas node is marked off-screen,
       let the browser skip rendering of its body content. Title bar / frame
       stay visible because content-visibility only applies to this element. */
    [data-node-id] [data-panel-content][data-culled="true"] {
      content-visibility: auto;
      contain-intrinsic-size: auto 400px;
    }
    /* Phase 2.6 — suppress shadow/border transitions during pan/zoom so the
       browser doesn't tick interpolated styles for every node every frame. */
    .canvas-interacting [data-node-id] {
      transition: none !important;
    }
  `
  document.head.appendChild(style)
}

const CanvasRegionItem: React.FC<{ id: string; zoomLevel: number }> = React.memo(({ id, zoomLevel }) => {
  const region = useCanvasStoreContext((s) => s.regions[id])
  if (!region) return null
  return <CanvasRegionComponent region={region} zoomLevel={zoomLevel} />
})

const RegionsLayer: React.FC = React.memo(() => {
  const zoomLevel = useCanvasStoreContext((s) => s.zoomLevel)
  const regionIds = useCanvasStoreContext((s) => s.regionIdList, shallow)
  return (
    <>
      {regionIds.map((id) => (
        <CanvasRegionItem key={id} id={id} zoomLevel={zoomLevel} />
      ))}
    </>
  )
})

const CanvasAnnotationItem: React.FC<{ id: string }> = React.memo(({ id }) => {
  const annotation = useCanvasStoreContext((s) => s.annotations[id])
  if (!annotation) return null
  return <CanvasAnnotationComponent annotation={annotation} />
})

const AnnotationsLayer: React.FC = React.memo(() => {
  const annotationIds = useCanvasStoreContext((s) => s.annotationIdList, shallow)
  return (
    <>
      {annotationIds.map((id) => (
        <CanvasAnnotationItem key={id} id={id} />
      ))}
    </>
  )
})

// -----------------------------------------------------------------------------
// Viewport AABB context — exposes the visible canvas-space rect to nodes for
// content-visibility culling. Updated imperatively from canvasApi.subscribe so
// Canvas itself never re-renders during pan/zoom.
// -----------------------------------------------------------------------------

export interface ViewportAABB {
  left: number
  top: number
  right: number
  bottom: number
}

interface ViewportAABBApi {
  get: () => ViewportAABB | null
  /** Subscribe to viewport AABB updates. Listener is called on every commit. */
  subscribe: (listener: (aabb: ViewportAABB) => void) => () => void
}

const ViewportAABBContext = createContext<ViewportAABBApi | null>(null)

export function useViewportAABBApi(): ViewportAABBApi | null {
  return useContext(ViewportAABBContext)
}

interface CanvasProps {
  children?: React.ReactNode
  /** Called when the user right-clicks empty canvas and picks a panel type. */
  onCreateAtPoint?: (type: PanelType, canvasPoint: Point) => void
}

const Canvas: React.FC<CanvasProps> = ({ children, onCreateAtPoint }) => {
  const canvasRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const canvasApi = useCanvasStoreApi()
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })

  // Viewport AABB (canvas-space) — refs + listener list so nodes can subscribe
  // imperatively. Updated on every zoom/offset change inside the same
  // canvasApi.subscribe block that writes the world transform.
  const viewportAABBRef = useRef<ViewportAABB | null>(null)
  const viewportAABBListeners = useRef<Set<(aabb: ViewportAABB) => void>>(new Set())
  const viewportAABBApi = useMemo<ViewportAABBApi>(() => ({
    get: () => viewportAABBRef.current,
    subscribe: (listener) => {
      viewportAABBListeners.current.add(listener)
      // Push current value immediately so subscribers don't have to wait for a
      // pan/zoom to learn the initial AABB.
      const cur = viewportAABBRef.current
      if (cur) listener(cur)
      return () => { viewportAABBListeners.current.delete(listener) }
    },
  }), [])

  const marquee = useUIStore((s) => s.marquee)
  const drawMode = useCanvasStoreContext((s) => s.drawMode)

  const {
    handleWheel,
    handleMouseDown: baseHandleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleContextMenu,
    canvasContextMenu,
    closeCanvasContextMenu,
  } = useCanvasInteraction(canvasRef, canvasApi)

  // Freehand drawing capture — when drawMode is on, mousedown on empty canvas
  // begins a stroke. Points accumulate in a ref; mousemove appends; mouseup
  // commits to the store as a CanvasDrawing. Suppresses pan/marquee while drawing.
  const drawPointsRef = useRef<Point[] | null>(null)
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (drawMode && e.button === 0) {
      const target = e.target as HTMLElement
      // Only start drawing on the canvas background, not on a node/region/annotation.
      const onNode = target.closest('[data-canvas-node],[data-region],[data-annotation]')
      if (!onNode) {
        const rect = canvasRef.current?.getBoundingClientRect()
        if (rect) {
          const state = canvasApi.getState()
          const p = viewToCanvas({ x: e.clientX - rect.left, y: e.clientY - rect.top }, state.zoomLevel, state.viewportOffset)
          drawPointsRef.current = [p]
          e.preventDefault()
          e.stopPropagation()
          return
        }
      }
    }
    baseHandleMouseDown(e)
  }, [drawMode, canvasApi, baseHandleMouseDown])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!drawPointsRef.current) return
      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) return
      const state = canvasApi.getState()
      const p = viewToCanvas({ x: e.clientX - rect.left, y: e.clientY - rect.top }, state.zoomLevel, state.viewportOffset)
      drawPointsRef.current.push(p)
    }
    const onUp = () => {
      const pts = drawPointsRef.current
      drawPointsRef.current = null
      if (pts && pts.length >= 2) canvasApi.getState().addDrawing(pts)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [canvasApi])

  // Inject the canvas-interacting style once at module level (not per mount)
  useEffect(injectCanvasInteractingStyle, [])

  // Imperatively update the world div transform on zoom/offset changes so
  // Canvas itself never re-renders during pan/zoom — only the world div moves.
  useEffect(() => {
    const applyTransform = (zoom: number, offset: { x: number; y: number }) => {
      const el = worldRef.current
      if (!el) return
      el.style.transform = `scale(${zoom}) translate(${offset.x / zoom}px, ${offset.y / zoom}px)`
      el.style.setProperty('--zoom', String(zoom))
    }

    // Compute and dispatch the visible canvas-space AABB with a generous
    // margin so scrolling in doesn't pop culled content.
    const CULL_MARGIN_PX = 200
    const dispatchAABB = (zoom: number, offset: { x: number; y: number }) => {
      const cw = canvasRef.current?.clientWidth ?? 0
      const ch = canvasRef.current?.clientHeight ?? 0
      if (cw === 0 || ch === 0 || zoom <= 0) return
      const marginX = CULL_MARGIN_PX / zoom
      const marginY = CULL_MARGIN_PX / zoom
      const aabb: ViewportAABB = {
        left: -offset.x / zoom - marginX,
        top: -offset.y / zoom - marginY,
        right: (cw - offset.x) / zoom + marginX,
        bottom: (ch - offset.y) / zoom + marginY,
      }
      viewportAABBRef.current = aabb
      for (const l of viewportAABBListeners.current) l(aabb)
    }

    // Apply current state immediately on mount
    const { zoomLevel, viewportOffset } = canvasApi.getState()
    applyTransform(zoomLevel, viewportOffset)
    dispatchAABB(zoomLevel, viewportOffset)

    // Subscribe to future changes
    const unsubscribe = canvasApi.subscribe((state, prev) => {
      if (state.zoomLevel !== prev.zoomLevel || state.viewportOffset !== prev.viewportOffset) {
        applyTransform(state.zoomLevel, state.viewportOffset)
        dispatchAABB(state.zoomLevel, state.viewportOffset)
      } else if (state.containerSize !== prev.containerSize) {
        dispatchAABB(state.zoomLevel, state.viewportOffset)
      }
    })
    return unsubscribe
  }, []) // mount-only

  // Auto-focus the node that occupies the most visible viewport area (opt-in).
  useAutoFocusLargestVisible(canvasApi)

  // Register canvas as a drop zone for dock-aware drag-and-drop
  // Canvases live in the center dock zone
  useEffect(() => {
    return registerDropZone({
      id: 'canvas-main',
      zone: 'center',
      getRect: () => canvasRef.current?.getBoundingClientRect() ?? null,
    })
  }, [])

  // Register wheel listener with { passive: false } so preventDefault works
  // React's onWheel is passive by default, which silently ignores preventDefault
  const handleWheelRef = useRef(handleWheel)
  handleWheelRef.current = handleWheel

  useEffect(() => {
    const el = canvasRef.current
    if (!el) return

    const onWheel = (e: WheelEvent) => {
      handleWheelRef.current(e as unknown as React.WheelEvent<HTMLDivElement>)
    }

    el.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => el.removeEventListener('wheel', onWheel, { capture: true })
  }, []) // mount-only — no dependency on handleWheel

  // Track container size for grid visibility calculations
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const size = {
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        }
        setContainerSize(size)
        canvasApi.getState().setContainerSize(size)
      }
    })

    observer.observe(el)
    const initialSize = {
      width: el.clientWidth,
      height: el.clientHeight,
    }
    setContainerSize(initialSize)
    canvasApi.getState().setContainerSize(initialSize)

    return () => observer.disconnect()
  }, [])

  // Click on the canvas background (world div) to unfocus
  const handleWorldClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Only unfocus if clicking directly on the world div, not on a child node
      const target = e.target as HTMLElement
      if (!target.closest('[data-node-id]') && !target.closest('[data-region-id]')) {
        canvasApi.getState().unfocus()
      }
    },
    [],
  )

  const handleFileDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes('application/cate-file')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  const handleFileDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    // Support multi-file drops
    const multiData = e.dataTransfer.getData('application/cate-files')
    const singlePath = e.dataTransfer.getData('application/cate-file')
    let filePaths: string[] = []
    if (multiData) {
      try { filePaths = JSON.parse(multiData) } catch { /* ignore */ }
    }
    if (filePaths.length === 0 && singlePath) {
      filePaths = [singlePath]
    }
    if (filePaths.length === 0) return

    e.preventDefault()
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const viewPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const { zoomLevel, viewportOffset } = canvasApi.getState()
    const canvasPoint = viewToCanvas(viewPoint, zoomLevel, viewportOffset)
    const wsId = useAppStore.getState().selectedWorkspaceId

    // Open each file, staggering position so they don't stack exactly
    let offsetX = 0
    for (const filePath of filePaths) {
      // Don't create editors for directories
      try {
        const stat = await window.electronAPI.fsStat(filePath)
        if (stat?.isDirectory) continue
      } catch { /* fall through */ }
      useAppStore.getState().createEditor(wsId, filePath, {
        x: canvasPoint.x + offsetX,
        y: canvasPoint.y,
      })
      offsetX += 40
    }
  }, [canvasRef])

  // Memoize marquee rect to avoid recalculation in render
  const marqueeRect = useMemo(() => {
    if (!marquee) return null
    return {
      x: Math.min(marquee.startX, marquee.currentX),
      y: Math.min(marquee.startY, marquee.currentY),
      w: Math.abs(marquee.currentX - marquee.startX),
      h: Math.abs(marquee.currentY - marquee.startY),
    }
  }, [marquee])

  // When the interaction hook flags a right-click on empty canvas, fire a
  // native context menu and dispatch the picked action.
  useEffect(() => {
    if (!canvasContextMenu || !window.electronAPI) return
    let cancelled = false
    const point = canvasContextMenu.canvasPoint
    const items: Array<{ id?: string; label?: string; type?: 'separator' }> = []
    if (onCreateAtPoint) {
      items.push(
        { id: 'new-terminal', label: 'New Terminal' },
        { id: 'new-editor', label: 'New Editor' },
        { id: 'new-browser', label: 'New Browser' },
        { id: 'new-canvas', label: 'New Canvas' },
        { type: 'separator' },
      )
    }
    items.push(
      { id: 'new-region', label: 'New Region' },
      { id: 'new-sticky', label: 'New Sticky Note' },
      { id: 'new-label', label: 'New Text Label' },
    )
    window.electronAPI.showContextMenu(items).then((id) => {
      if (cancelled) return
      closeCanvasContextMenu()
      switch (id) {
        case 'new-terminal': onCreateAtPoint?.('terminal', point); break
        case 'new-editor': onCreateAtPoint?.('editor', point); break
        case 'new-browser': onCreateAtPoint?.('browser', point); break
        case 'new-canvas': onCreateAtPoint?.('canvas', point); break
        case 'new-region':
          canvasApi.getState().addRegion('Region', point, { width: 400, height: 300 })
          break
        case 'new-sticky':
          canvasApi.getState().addAnnotation('stickyNote', point)
          break
        case 'new-label':
          canvasApi.getState().addAnnotation('textLabel', point)
          break
      }
    })
    return () => { cancelled = true }
  }, [canvasContextMenu, onCreateAtPoint, canvasApi, closeCanvasContextMenu])

  return (
    <ViewportAABBContext.Provider value={viewportAABBApi}>
    <div
      ref={canvasRef}
      data-canvas-container
      className="relative w-full h-full overflow-hidden bg-canvas-bg"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onContextMenu={handleContextMenu}
      onDragOver={handleFileDragOver}
      onDrop={handleFileDrop}
    >
      {/* World div: transformed to implement pan/zoom */}
      <div
        ref={worldRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: 1,
          height: 1,
          transformOrigin: '0 0',
          willChange: 'transform',
        }}
        onClick={handleWorldClick}
      >
        <CanvasGrid
          containerWidth={containerSize.width}
          containerHeight={containerSize.height}
        />
        <RegionsLayer />
        <AnnotationsLayer />
        <CanvasDrawings />
        <SnapGuides />
        {marqueeRect && (
          <div
            style={{
              position: 'absolute',
              left: marqueeRect.x,
              top: marqueeRect.y,
              width: marqueeRect.w,
              height: marqueeRect.h,
              backgroundColor: 'rgba(74, 158, 255, 0.1)',
              border: '1px solid rgba(74, 158, 255, 0.5)',
              borderRadius: 2,
              pointerEvents: 'none',
              zIndex: 99999,
            }}
          />
        )}
        {children}
      </div>

    </div>
    </ViewportAABBContext.Provider>
  )
}

export default Canvas
