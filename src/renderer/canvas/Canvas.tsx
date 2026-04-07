// =============================================================================
// Canvas — the main infinite canvas component.
// Ported from CanvasView.swift.
// =============================================================================

import React, { useRef, useCallback, useEffect, useMemo, useState } from 'react'
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
  `
  document.head.appendChild(style)
}

const RegionsLayer: React.FC<{ zoomLevel: number }> = React.memo(({ zoomLevel }) => {
  const regionList = useCanvasStoreContext(
    (s) => Object.values(s.regions),
    shallow,
  )
  return (
    <>
      {regionList.map((region) => (
        <CanvasRegionComponent key={region.id} region={region} zoomLevel={zoomLevel} />
      ))}
    </>
  )
})

const AnnotationsLayer: React.FC = React.memo(() => {
  const annotationList = useCanvasStoreContext(
    (s) => Object.values(s.annotations),
    shallow,
  )
  return (
    <>
      {annotationList.map((ann) => (
        <CanvasAnnotationComponent key={ann.id} annotation={ann} />
      ))}
    </>
  )
})

interface CanvasProps {
  children?: React.ReactNode
  /** Called when the user right-clicks empty canvas and picks a panel type. */
  onCreateAtPoint?: (type: PanelType, canvasPoint: Point) => void
}

const Canvas: React.FC<CanvasProps> = ({ children, onCreateAtPoint }) => {
  const canvasRef = useRef<HTMLDivElement>(null)
  const canvasApi = useCanvasStoreApi()
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })

  const zoom = useCanvasStoreContext((s) => s.zoomLevel)
  const offset = useCanvasStoreContext((s) => s.viewportOffset)
  const marquee = useUIStore((s) => s.marquee)

  const {
    handleWheel,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleContextMenu,
    canvasContextMenu,
    closeCanvasContextMenu,
  } = useCanvasInteraction(canvasRef, canvasApi)

  // Inject the canvas-interacting style once at module level (not per mount)
  useEffect(injectCanvasInteractingStyle, [])

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

  // CSS transform: scale first, then translate (divide offset by zoom since
  // the translate happens in the scaled coordinate space)
  const worldTransform = `scale(${zoom}) translate(${offset.x / zoom}px, ${offset.y / zoom}px)`

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
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: 1,
          height: 1,
          transform: worldTransform,
          transformOrigin: '0 0',
          willChange: 'transform',
          ['--zoom' as string]: zoom,
        }}
        onClick={handleWorldClick}
      >
        <CanvasGrid
          containerWidth={containerSize.width}
          containerHeight={containerSize.height}
        />
        <RegionsLayer zoomLevel={zoom} />
        <AnnotationsLayer />
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
  )
}

export default Canvas
