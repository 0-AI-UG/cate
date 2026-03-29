// =============================================================================
// Canvas — the main infinite canvas component.
// Ported from CanvasView.swift.
// =============================================================================

import React, { useRef, useCallback, useEffect, useState } from 'react'
import { useCanvasStore } from '../stores/canvasStore'
import { useAppStore } from '../stores/appStore'
import { useCanvasInteraction } from '../hooks/useCanvasInteraction'
import { useUIStore } from '../stores/uiStore'
import { viewToCanvas } from '../lib/coordinates'
import CanvasGrid from './CanvasGrid'
import SnapGuides from './SnapGuides'
import ContextMenu from '../ui/ContextMenu'
import CanvasRegionComponent from './CanvasRegionComponent'
import CanvasAnnotationComponent from './CanvasAnnotationComponent'
import type { Point, PanelType } from '../../shared/types'

interface CanvasProps {
  children?: React.ReactNode
  /** Called when the user right-clicks empty canvas and picks a panel type. */
  onCreateAtPoint?: (type: PanelType, canvasPoint: Point) => void
}

const Canvas: React.FC<CanvasProps> = ({ children, onCreateAtPoint }) => {
  const canvasRef = useRef<HTMLDivElement>(null)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })

  const zoom = useCanvasStore((s) => s.zoomLevel)
  const offset = useCanvasStore((s) => s.viewportOffset)
  const regions = useCanvasStore((s) => s.regions)
  const annotations = useCanvasStore((s) => s.annotations)
  const marquee = useUIStore((s) => s.marquee)

  const {
    handleWheel,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleContextMenu,
    canvasContextMenu,
    closeCanvasContextMenu,
  } = useCanvasInteraction(canvasRef)

  // Inject a one-time global style that disables pointer events on iframes,
  // webviews, and Monaco editors while a canvas interaction is in progress.
  useEffect(() => {
    const style = document.createElement('style')
    style.textContent = `
      .canvas-interacting iframe,
      .canvas-interacting webview,
      .canvas-interacting .monaco-editor {
        pointer-events: none !important;
      }
    `
    document.head.appendChild(style)
    return () => { document.head.removeChild(style) }
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
        useCanvasStore.getState().setContainerSize(size)
      }
    })

    observer.observe(el)
    const initialSize = {
      width: el.clientWidth,
      height: el.clientHeight,
    }
    setContainerSize(initialSize)
    useCanvasStore.getState().setContainerSize(initialSize)

    return () => observer.disconnect()
  }, [])

  // Click on the canvas background (world div) to unfocus
  const handleWorldClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Only unfocus if clicking directly on the world div, not on a child node
      const target = e.target as HTMLElement
      if (!target.closest('[data-node-id]') && !target.closest('[data-region-id]')) {
        useCanvasStore.getState().unfocus()
      }
    },
    [],
  )

  const handleFileDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes('application/canvaside-file')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  const handleFileDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const filePath = e.dataTransfer.getData('application/canvaside-file')
    if (!filePath) return
    e.preventDefault()
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const viewPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const { zoomLevel, viewportOffset } = useCanvasStore.getState()
    const canvasPoint = viewToCanvas(viewPoint, zoomLevel, viewportOffset)
    const wsId = useAppStore.getState().selectedWorkspaceId
    useAppStore.getState().createEditor(wsId, filePath, canvasPoint)
  }, [canvasRef])

  // CSS transform: scale first, then translate (divide offset by zoom since
  // the translate happens in the scaled coordinate space)
  const worldTransform = `scale(${zoom}) translate(${offset.x / zoom}px, ${offset.y / zoom}px)`

  // Build context menu items for creating panels at a specific canvas position
  const contextMenuItems = canvasContextMenu
    ? [
        ...(onCreateAtPoint
          ? [
              {
                label: 'New Terminal',
                onClick: () => {
                  onCreateAtPoint('terminal', canvasContextMenu.canvasPoint)
                },
              },
              {
                label: 'New Editor',
                onClick: () => {
                  onCreateAtPoint('editor', canvasContextMenu.canvasPoint)
                },
              },
              {
                label: 'New Browser',
                onClick: () => {
                  onCreateAtPoint('browser', canvasContextMenu.canvasPoint)
                },
              },
            ]
          : []),
        {
          label: 'New Region',
          onClick: () => {
            useCanvasStore.getState().addRegion(
              'Region',
              canvasContextMenu.canvasPoint,
              { width: 400, height: 300 },
            )
          },
        },
        {
          label: 'New Sticky Note',
          onClick: () => {
            if (canvasContextMenu) {
              useCanvasStore.getState().addAnnotation('stickyNote', canvasContextMenu.canvasPoint)
            }
          },
        },
        {
          label: 'New Text Label',
          onClick: () => {
            if (canvasContextMenu) {
              useCanvasStore.getState().addAnnotation('textLabel', canvasContextMenu.canvasPoint)
            }
          },
        },
      ]
    : []

  return (
    <div
      ref={canvasRef}
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
        }}
        onClick={handleWorldClick}
      >
        <CanvasGrid
          containerWidth={containerSize.width}
          containerHeight={containerSize.height}
        />
        {Object.values(regions).map((region) => (
          <CanvasRegionComponent key={region.id} region={region} zoomLevel={zoom} />
        ))}
        {Object.values(annotations).map((ann) => (
          <CanvasAnnotationComponent key={ann.id} annotation={ann} />
        ))}
        <SnapGuides />
        {marquee && (() => {
          const x = Math.min(marquee.startX, marquee.currentX)
          const y = Math.min(marquee.startY, marquee.currentY)
          const w = Math.abs(marquee.currentX - marquee.startX)
          const h = Math.abs(marquee.currentY - marquee.startY)
          return (
            <div
              style={{
                position: 'absolute',
                left: x,
                top: y,
                width: w,
                height: h,
                backgroundColor: 'rgba(74, 158, 255, 0.1)',
                border: '1px solid rgba(74, 158, 255, 0.5)',
                borderRadius: 2,
                pointerEvents: 'none',
                zIndex: 99999,
              }}
            />
          )
        })()}
        {children}
      </div>

      {/* Canvas background right-click context menu */}
      {canvasContextMenu && (
        <ContextMenu
          x={canvasContextMenu.x}
          y={canvasContextMenu.y}
          items={contextMenuItems}
          onClose={closeCanvasContextMenu}
        />
      )}
    </div>
  )
}

export default Canvas
