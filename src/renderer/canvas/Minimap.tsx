// =============================================================================
// Minimap — Bird's-eye overview of all panels on the canvas.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useCanvasStoreContext, useCanvasStoreApi, shallow } from '../stores/CanvasStoreContext'
import { useWorkspacePanels } from '../stores/appStore'
import { panelColor as brandPanelColor } from '../panels/types'

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

function mutedPanelColor(panelType: string): string {
  switch (panelType) {
    case 'terminal': return '#4a9960'
    case 'editor': return '#b07440'
    case 'browser': return '#4a7ab0'
    default: return '#888'
  }
}

interface MinimapProps {
  mode?: 'floating' | 'popover'
}

const Minimap: React.FC<MinimapProps> = ({ mode = 'floating' }) => {
  const nodeList = useCanvasStoreContext((s) => Object.values(s.nodes), shallow)
  const regionList = useCanvasStoreContext((s) => Object.values(s.regions), shallow)
  // NOTE: viewportOffset is intentionally NOT subscribed via React here.
  // The viewport rect div is updated imperatively via canvasApi.subscribe
  // so panning never triggers a Minimap re-render.
  const zoomLevel = useCanvasStoreContext((s) => s.zoomLevel)
  const containerSize = useCanvasStoreContext(
    (s) => s.containerSize,
    (a, b) => a.width === b.width && a.height === b.height,
  )
  const panels = useWorkspacePanels()
  const canvasApi = useCanvasStoreApi()
  const minimapRef = useRef<HTMLDivElement>(null)
  // Ref to the viewport indicator div — updated imperatively on pan
  const viewportRectRef = useRef<HTMLDivElement>(null)
  // Stable ref for minimap layout params so the subscription callback always
  // reads fresh values without needing to re-subscribe.
  const layoutRef = useRef({
    worldMinX: 0, worldMinY: 0, scale: 1,
    zoomLevel: 1, containerWidth: 0, containerHeight: 0,
  })
  const [corner, setCorner] = useState<Corner>(loadCorner)
  const [size, setSize] = useState<{ w: number; h: number }>(loadSize)
  const MINIMAP_WIDTH = mode === 'popover' ? 220 : size.w
  const MINIMAP_HEIGHT = mode === 'popover' ? 160 : size.h

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

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (!minimapRef.current) return
    // Capture world bounds + scale ONCE at drag start so the mapping stays linear
    // for the whole drag — otherwise each mousemove re-derives bounds that include
    // the current viewport, which shifts the scale and makes motion accelerate.
    const { worldMinX, worldMinY, scale } = layoutRef.current
    const rect = minimapRef.current.getBoundingClientRect()

    const navigate = (clientX: number, clientY: number) => {
      const state = canvasApi.getState()
      const canvasX = (clientX - rect.left - MINIMAP_PADDING) / scale + worldMinX
      const canvasY = (clientY - rect.top - MINIMAP_PADDING) / scale + worldMinY
      state.setViewportOffset({
        x: state.containerSize.width / 2 - canvasX * state.zoomLevel,
        y: state.containerSize.height / 2 - canvasY * state.zoomLevel,
      })
    }

    navigate(e.clientX, e.clientY)
    const handleMove = (ev: MouseEvent) => navigate(ev.clientX, ev.clientY)
    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
  }, [canvasApi])

  // Imperatively update the viewport rect on pan — no React re-render needed.
  useEffect(() => {
    const unsubscribe = canvasApi.subscribe((state, prev) => {
      if (state.viewportOffset === prev.viewportOffset) return
      const el = viewportRectRef.current
      if (!el) return
      const { worldMinX, worldMinY, scale, zoomLevel, containerWidth, containerHeight } = layoutRef.current
      const vpL = -state.viewportOffset.x / zoomLevel
      const vpT = -state.viewportOffset.y / zoomLevel
      el.style.left = `${MINIMAP_PADDING + (vpL - worldMinX) * scale}px`
      el.style.top = `${MINIMAP_PADDING + (vpT - worldMinY) * scale}px`
      el.style.width = `${(containerWidth / zoomLevel) * scale}px`
      el.style.height = `${(containerHeight / zoomLevel) * scale}px`
    })
    return unsubscribe
  }, [canvasApi])

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

  // Seed world bounds from current offset (used for initial render and re-renders on zoom/node change)
  const seedOffset = canvasApi.getState().viewportOffset
  const vpLeft0 = -seedOffset.x / zoomLevel
  const vpTop0 = -seedOffset.y / zoomLevel
  const vpRight0 = vpLeft0 + containerSize.width / zoomLevel
  const vpBottom0 = vpTop0 + containerSize.height / zoomLevel

  const worldMinX = Math.min(minX, vpLeft0) - 100
  const worldMinY = Math.min(minY, vpTop0) - 100
  const worldMaxX = Math.max(maxX, vpRight0) + 100
  const worldMaxY = Math.max(maxY, vpBottom0) + 100

  const worldW = worldMaxX - worldMinX
  const worldH = worldMaxY - worldMinY

  // Scale to fit minimap
  const innerW = MINIMAP_WIDTH - MINIMAP_PADDING * 2
  const innerH = MINIMAP_HEIGHT - MINIMAP_PADDING * 2
  const scale = Math.min(innerW / worldW, innerH / worldH)

  const toMiniX = (x: number) => MINIMAP_PADDING + (x - worldMinX) * scale
  const toMiniY = (y: number) => MINIMAP_PADDING + (y - worldMinY) * scale

  // Initial viewport rect position (for render)
  const vpRectLeft = toMiniX(vpLeft0)
  const vpRectTop = toMiniY(vpTop0)
  const vpRectWidth = (containerSize.width / zoomLevel) * scale
  const vpRectHeight = (containerSize.height / zoomLevel) * scale

  // Keep layoutRef up to date so the imperative subscription always has fresh values
  layoutRef.current = {
    worldMinX,
    worldMinY,
    scale,
    zoomLevel,
    containerWidth: containerSize.width,
    containerHeight: containerSize.height,
  }

  const isPopover = mode === 'popover'

  return (
    <div
      ref={minimapRef}
      style={{
        ...(isPopover
          ? { position: 'relative' as const }
          : {
              position: 'absolute' as const,
              ...(corner.startsWith('bottom') ? { bottom: MINIMAP_GAP } : { top: MINIMAP_GAP }),
              ...(corner.endsWith('right') ? { right: MINIMAP_GAP } : { left: MINIMAP_GAP }),
              opacity: 0.7,
              zIndex: 20,
            }),
        width: MINIMAP_WIDTH,
        height: MINIMAP_HEIGHT,
        backgroundColor: 'var(--surface-2)',
        borderRadius: 8,
        border: `1px solid var(--border-subtle)`,
        overflow: 'hidden',
        cursor: 'crosshair',
      }}
      onMouseDown={handleMouseDown}
    >
      {/* Resize handle — on the inner corner (pointing toward canvas center). Hidden in popover mode. */}
      {!isPopover && (
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
      )}

      {/* Drag handle — on the outer corner (against the screen edge). Hidden in popover mode. */}
      {!isPopover && (
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
      )}

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
              backgroundColor: isPopover ? brandPanelColor(type as any) : mutedPanelColor(type),
              borderRadius: 1,
              opacity: 1,
            }}
          />
        )
      })}

      {/* Viewport rectangle — position is updated imperatively by canvasApi.subscribe */}
      <div
        ref={viewportRectRef}
        style={{
          position: 'absolute',
          left: vpRectLeft,
          top: vpRectTop,
          width: vpRectWidth,
          height: vpRectHeight,
          border: `1.5px solid var(--border-strong)`,
          borderRadius: 2,
          pointerEvents: 'none',
        }}
      />
    </div>
  )
}

export default React.memo(Minimap)
