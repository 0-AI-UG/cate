// =============================================================================
// Minimap — Bird's-eye overview of all panels on the canvas.
// =============================================================================

import React, { useCallback, useMemo, useRef, useState } from 'react'
import { useCanvasStoreContext, useCanvasStoreApi, shallow } from '../stores/CanvasStoreContext'
import { useWorkspacePanels } from '../stores/appStore'

const MINIMAP_DEFAULT_WIDTH = 200
const MINIMAP_DEFAULT_HEIGHT = 150
const MINIMAP_MIN_WIDTH = 120
const MINIMAP_MIN_HEIGHT = 90
const MINIMAP_MAX_WIDTH = 600
const MINIMAP_MAX_HEIGHT = 500
const MINIMAP_PADDING = 10
const MINIMAP_GAP = 12

type Corner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'
const CORNER_KEY = 'cate.minimap.corner'
const SIZE_KEY = 'cate.minimap.size'
const loadCorner = (): Corner => {
  const v = (typeof localStorage !== 'undefined' && localStorage.getItem(CORNER_KEY)) as Corner | null
  return v || 'bottom-right'
}
const loadSize = (): { w: number; h: number } => {
  try {
    const raw = localStorage.getItem(SIZE_KEY)
    if (raw) {
      const p = JSON.parse(raw)
      if (typeof p.w === 'number' && typeof p.h === 'number') return { w: p.w, h: p.h }
    }
  } catch {}
  return { w: MINIMAP_DEFAULT_WIDTH, h: MINIMAP_DEFAULT_HEIGHT }
}

function panelColor(panelType: string): string {
  switch (panelType) {
    case 'terminal': return '#4a9960'
    case 'editor': return '#b07440'
    case 'browser': return '#4a7ab0'
    default: return '#888'
  }
}

const Minimap: React.FC = () => {
  const nodeList = useCanvasStoreContext((s) => Object.values(s.nodes), shallow)
  const regionList = useCanvasStoreContext((s) => Object.values(s.regions), shallow)
  const viewportOffset = useCanvasStoreContext((s) => s.viewportOffset)
  const zoomLevel = useCanvasStoreContext((s) => s.zoomLevel)
  const containerSize = useCanvasStoreContext(
    (s) => s.containerSize,
    (a, b) => a.width === b.width && a.height === b.height,
  )
  const panels = useWorkspacePanels()
  const canvasApi = useCanvasStoreApi()
  const minimapRef = useRef<HTMLDivElement>(null)
  const [corner, setCorner] = useState<Corner>(loadCorner)
  const [size, setSize] = useState<{ w: number; h: number }>(loadSize)
  const MINIMAP_WIDTH = size.w
  const MINIMAP_HEIGHT = size.h

  const sizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cornerDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const startW = size.w
    const startH = size.h
    // Resize handle sits on the corner pointing toward canvas center (opposite of `corner`).
    // Dragging that corner away from the minimap's anchored corner grows it.
    const signX = corner.endsWith('right') ? -1 : 1 // anchored right → grow when moving left
    const signY = corner.startsWith('bottom') ? -1 : 1 // anchored bottom → grow when moving up
    const handleMove = (ev: MouseEvent) => {
      const dx = (ev.clientX - startX) * signX
      const dy = (ev.clientY - startY) * signY
      const w = Math.max(MINIMAP_MIN_WIDTH, Math.min(MINIMAP_MAX_WIDTH, startW + dx))
      const h = Math.max(MINIMAP_MIN_HEIGHT, Math.min(MINIMAP_MAX_HEIGHT, startH + dy))
      setSize({ w, h })
      if (sizeDebounceRef.current) clearTimeout(sizeDebounceRef.current)
      sizeDebounceRef.current = setTimeout(() => {
        try { localStorage.setItem(SIZE_KEY, JSON.stringify({ w, h })) } catch {}
      }, 500)
    }
    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
  }, [size.w, size.h, corner])

  const handleDragHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const handleMove = (ev: MouseEvent) => {
      const cw = containerSize.width
      const ch = containerSize.height
      const right = ev.clientX > cw / 2
      const bottom = ev.clientY > ch / 2
      const next: Corner = `${bottom ? 'bottom' : 'top'}-${right ? 'right' : 'left'}` as Corner
      setCorner((prev) => {
        if (prev === next) return prev
        if (cornerDebounceRef.current) clearTimeout(cornerDebounceRef.current)
        cornerDebounceRef.current = setTimeout(() => {
          try { localStorage.setItem(CORNER_KEY, next) } catch {}
        }, 500)
        return next
      })
    }
    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
  }, [containerSize.width, containerSize.height])

  // Handle click/drag to navigate (must be before any early returns)
  const navigateToPoint = useCallback((clientX: number, clientY: number) => {
    if (!minimapRef.current) return
    const state = canvasApi.getState()
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

  const contentBounds = useMemo(() => {
    if (nodeList.length === 0) return null
    const minX = Math.min(
      ...nodeList.map(n => n.origin.x),
      ...(regionList.length > 0 ? regionList.map(r => r.origin.x) : []),
    )
    const minY = Math.min(
      ...nodeList.map(n => n.origin.y),
      ...(regionList.length > 0 ? regionList.map(r => r.origin.y) : []),
    )
    const maxX = Math.max(
      ...nodeList.map(n => n.origin.x + n.size.width),
      ...(regionList.length > 0 ? regionList.map(r => r.origin.x + r.size.width) : []),
    )
    const maxY = Math.max(
      ...nodeList.map(n => n.origin.y + n.size.height),
      ...(regionList.length > 0 ? regionList.map(r => r.origin.y + r.size.height) : []),
    )
    return { minX, minY, maxX, maxY }
  }, [nodeList, regionList])

  if (!contentBounds) return null

  const { minX, minY, maxX, maxY } = contentBounds

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
        ...(corner.startsWith('bottom') ? { bottom: MINIMAP_GAP } : { top: MINIMAP_GAP }),
        ...(corner.endsWith('right') ? { right: MINIMAP_GAP } : { left: MINIMAP_GAP }),
        width: MINIMAP_WIDTH,
        height: MINIMAP_HEIGHT,
        backgroundColor: 'var(--surface-2)',
        opacity: 0.7,
        borderRadius: 8,
        border: `1px solid var(--border-subtle)`,
        overflow: 'hidden',
        cursor: 'crosshair',
        zIndex: 20,
      }}
      onMouseDown={handleMouseDown}
    >
      {/* Resize handle — on the inner corner (pointing toward canvas center) */}
      <div
        onMouseDown={handleResizeMouseDown}
        title="Drag to resize minimap"
        style={{
          position: 'absolute',
          ...(corner.startsWith('bottom') ? { top: 0 } : { bottom: 0 }),
          ...(corner.endsWith('right') ? { left: 0 } : { right: 0 }),
          width: 14,
          height: 14,
          cursor: (corner === 'bottom-right' || corner === 'top-left') ? 'nwse-resize' : 'nesw-resize',
          zIndex: 3,
        }}
      />

      {/* Drag handle — on the outer corner (against the screen edge) */}
      <div
        onMouseDown={handleDragHandleMouseDown}
        title="Drag to move minimap"
        style={{
          position: 'absolute',
          ...(corner.startsWith('bottom') ? { bottom: 2 } : { top: 2 }),
          ...(corner.endsWith('right') ? { right: 2 } : { left: 2 }),
          width: 14,
          height: 14,
          borderRadius: 3,
          cursor: 'grab',
          zIndex: 2,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-muted)',
          fontSize: 10,
          lineHeight: 1,
          userSelect: 'none',
        }}
      >⠿</div>

      {/* Region rectangles */}
      {regionList.map((region) => (
        <div
          key={`region-${region.id}`}
          style={{
            position: 'absolute',
            left: toMiniX(region.origin.x),
            top: toMiniY(region.origin.y),
            width: Math.max(region.size.width * scale, 3),
            height: Math.max(region.size.height * scale, 3),
            border: `1px solid ${region.color.replace(/[\d.]+\)$/, '0.5)')}`,
            borderRadius: 1,
            backgroundColor: region.color.replace(/[\d.]+\)$/, '0.15)'),
          }}
        />
      ))}

      {/* Node rectangles */}
      {nodeList.map((node) => {
        const panel = panels?.[node.panelId]
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
              opacity: 1,
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
          border: `1.5px solid var(--border-strong)`,
          borderRadius: 2,
          pointerEvents: 'none',
        }}
      />
    </div>
  )
}

export default React.memo(Minimap)
