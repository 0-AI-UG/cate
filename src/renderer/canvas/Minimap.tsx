// =============================================================================
// Minimap — Bird's-eye overview of all panels on the canvas.
// =============================================================================

import React, { useCallback, useRef } from 'react'
import { useCanvasStore } from '../stores/canvasStore'
import { useAppStore } from '../stores/appStore'

const MINIMAP_WIDTH = 200
const MINIMAP_HEIGHT = 150
const MINIMAP_PADDING = 10

function panelColor(panelType: string): string {
  switch (panelType) {
    case 'terminal': return '#34C759'
    case 'editor': return '#FF9500'
    case 'browser': return '#007AFF'
    default: return '#888'
  }
}

const Minimap: React.FC = () => {
  const nodes = useCanvasStore((s) => s.nodes)
  const viewportOffset = useCanvasStore((s) => s.viewportOffset)
  const zoomLevel = useCanvasStore((s) => s.zoomLevel)
  const containerSize = useCanvasStore((s) => s.containerSize)
  const currentWorkspace = useAppStore((s) => s.workspaces.find(w => w.id === s.selectedWorkspaceId))
  const minimapRef = useRef<HTMLDivElement>(null)

  const nodeList = Object.values(nodes)

  // Handle click/drag to navigate (must be before any early returns)
  const navigateToPoint = useCallback((clientX: number, clientY: number) => {
    if (!minimapRef.current) return
    const state = useCanvasStore.getState()
    const nl = Object.values(state.nodes)
    if (nl.length === 0) return

    const bMinX = Math.min(...nl.map(n => n.origin.x))
    const bMinY = Math.min(...nl.map(n => n.origin.y))
    const bMaxX = Math.max(...nl.map(n => n.origin.x + n.size.width))
    const bMaxY = Math.max(...nl.map(n => n.origin.y + n.size.height))
    const vL = -state.viewportOffset.x / state.zoomLevel
    const vT = -state.viewportOffset.y / state.zoomLevel
    const vR = vL + state.containerSize.width / state.zoomLevel
    const vB = vT + state.containerSize.height / state.zoomLevel
    const wMinX = Math.min(bMinX, vL) - 100
    const wMinY = Math.min(bMinY, vT) - 100
    const wMaxX = Math.max(bMaxX, vR) + 100
    const wMaxY = Math.max(bMaxY, vB) + 100
    const iW = MINIMAP_WIDTH - MINIMAP_PADDING * 2
    const iH = MINIMAP_HEIGHT - MINIMAP_PADDING * 2
    const sc = Math.min(iW / (wMaxX - wMinX), iH / (wMaxY - wMinY))

    const rect = minimapRef.current.getBoundingClientRect()
    const canvasX = (clientX - rect.left - MINIMAP_PADDING) / sc + wMinX
    const canvasY = (clientY - rect.top - MINIMAP_PADDING) / sc + wMinY
    state.setViewportOffset({
      x: state.containerSize.width / 2 - canvasX * state.zoomLevel,
      y: state.containerSize.height / 2 - canvasY * state.zoomLevel,
    })
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    navigateToPoint(e.clientX, e.clientY)

    const handleMove = (ev: MouseEvent) => navigateToPoint(ev.clientX, ev.clientY)
    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
  }, [navigateToPoint])

  if (nodeList.length === 0) return null

  // Compute bounding box of all nodes
  const minX = Math.min(...nodeList.map(n => n.origin.x))
  const minY = Math.min(...nodeList.map(n => n.origin.y))
  const maxX = Math.max(...nodeList.map(n => n.origin.x + n.size.width))
  const maxY = Math.max(...nodeList.map(n => n.origin.y + n.size.height))

  // Add padding and include viewport bounds
  const vpLeft = -viewportOffset.x / zoomLevel
  const vpTop = -viewportOffset.y / zoomLevel
  const vpRight = vpLeft + containerSize.width / zoomLevel
  const vpBottom = vpTop + containerSize.height / zoomLevel

  const worldMinX = Math.min(minX, vpLeft) - 100
  const worldMinY = Math.min(minY, vpTop) - 100
  const worldMaxX = Math.max(maxX, vpRight) + 100
  const worldMaxY = Math.max(maxY, vpBottom) + 100

  const worldW = worldMaxX - worldMinX
  const worldH = worldMaxY - worldMinY

  // Scale to fit minimap
  const innerW = MINIMAP_WIDTH - MINIMAP_PADDING * 2
  const innerH = MINIMAP_HEIGHT - MINIMAP_PADDING * 2
  const scale = Math.min(innerW / worldW, innerH / worldH)

  const toMiniX = (x: number) => MINIMAP_PADDING + (x - worldMinX) * scale
  const toMiniY = (y: number) => MINIMAP_PADDING + (y - worldMinY) * scale

  return (
    <div
      ref={minimapRef}
      style={{
        position: 'absolute',
        bottom: 60,
        right: 12,
        width: MINIMAP_WIDTH,
        height: MINIMAP_HEIGHT,
        backgroundColor: 'rgba(30, 30, 36, 0.9)',
        borderRadius: 8,
        border: '1px solid rgba(255,255,255,0.1)',
        overflow: 'hidden',
        cursor: 'crosshair',
        zIndex: 20,
      }}
      onMouseDown={handleMouseDown}
    >
      {/* Node rectangles */}
      {nodeList.map((node) => {
        const panel = currentWorkspace?.panels[node.panelId]
        const type = panel?.type || 'terminal'
        return (
          <div
            key={node.id}
            style={{
              position: 'absolute',
              left: toMiniX(node.origin.x),
              top: toMiniY(node.origin.y),
              width: Math.max(node.size.width * scale, 2),
              height: Math.max(node.size.height * scale, 2),
              backgroundColor: panelColor(type),
              borderRadius: 1,
              opacity: 0.7,
            }}
          />
        )
      })}

      {/* Viewport rectangle */}
      <div
        style={{
          position: 'absolute',
          left: toMiniX(vpLeft),
          top: toMiniY(vpTop),
          width: (containerSize.width / zoomLevel) * scale,
          height: (containerSize.height / zoomLevel) * scale,
          border: '1.5px solid rgba(255,255,255,0.4)',
          borderRadius: 2,
          pointerEvents: 'none',
        }}
      />
    </div>
  )
}

export default React.memo(Minimap)
