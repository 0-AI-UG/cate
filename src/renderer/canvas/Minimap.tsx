// =============================================================================
// Minimap — Bird's-eye overview of all panels on the canvas.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useCanvasStoreContext, useCanvasStoreApi, shallow } from '../stores/CanvasStoreContext'
import { useWorkspacePanels, useAppStore } from '../stores/appStore'
import { useAgentInfoByPanel } from '../hooks/useAgentPanelInfo'
import { useUIStateStore } from '../stores/uiStateStore'
import { useWorktreeMembership } from './worktree/useWorktreeMembership'
import { activeDockPanelId } from '../../shared/collectPanelIds'

// Default minimap size lives in DEFAULT_UI_STATE (shared/types); the floating
// size is restored from ui-state.json.
const MINIMAP_MIN_WIDTH = 120
const MINIMAP_MIN_HEIGHT = 90
const MINIMAP_MAX_WIDTH = 600
const MINIMAP_MAX_HEIGHT = 500
const MINIMAP_PADDING = 10
const MINIMAP_GAP = 12

type Corner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'
// Minimap placement persists in ui-state.json via the UI-state store (loaded on
// launch, before the canvas mounts). These read the current store value.
const loadCorner = (): Corner => useUIStateStore.getState().minimapCorner
const loadSize = (): { w: number; h: number } => useUIStateStore.getState().minimapSize

// Map a panel type to a themed CSS variable so the minimap follows the active
// theme. Falls back to a generic surface accent for unknown types.
function themedPanelColor(panelType: string): string {
  switch (panelType) {
    case 'terminal':
    case 'browser':
    case 'editor':
    case 'canvas':
      return `var(--panel-${panelType})`
    default:
      return 'var(--text-muted)'
  }
}

interface MinimapProps {
  mode?: 'floating' | 'popover'
  /** Fired after a click/drag navigate gesture ends (mouse released). Lets a
   *  host — e.g. the command palette — dismiss itself once the user has jumped. */
  onNavigateEnd?: () => void
}

const Minimap: React.FC<MinimapProps> = ({ mode = 'floating', onNavigateEnd }) => {
  const nodeList = useCanvasStoreContext((s) => Object.values(s.nodes), shallow)
  // NOTE: viewportOffset is intentionally NOT subscribed via React here.
  // The viewport rect div is updated imperatively via canvasApi.subscribe
  // so panning never triggers a Minimap re-render.
  const zoomLevel = useCanvasStoreContext((s) => s.zoomLevel)
  const containerSize = useCanvasStoreContext(
    (s) => s.containerSize,
    (a, b) => a.width === b.width && a.height === b.height,
  )
  const panels = useWorkspacePanels()
  // Agent logos are keyed by panelId, scoped to the selected workspace — same
  // scope `useWorkspacePanels()` reads from, so they line up with the nodes.
  const workspaceId = useAppStore((s) => s.selectedWorkspaceId)
  const agentInfoByPanel = useAgentInfoByPanel(workspaceId)
  // Worktree membership: which nodes belong to which parallel branch, and in
  // what color. Empty (no outlines drawn) unless the workspace has 2+ worktrees
  // — same gate the canvas terrace uses, so the minimap never disagrees.
  const { groups } = useWorktreeMembership()
  // nodeId → worktree color, so each node rect can carry its branch color.
  const nodeColorById = useMemo(() => {
    const map: Record<string, string> = {}
    for (const g of groups) for (const id of g.nodeIds) map[id] = g.color
    return map
  }, [groups])
  const canvasApi = useCanvasStoreApi()
  const minimapRef = useRef<HTMLDivElement>(null)
  // Ref to the viewport indicator div — updated imperatively on pan
  const viewportRectRef = useRef<HTMLDivElement>(null)
  // Stable ref for minimap layout params so the subscription callback always
  // reads fresh values without needing to re-subscribe.
  const layoutRef = useRef({
    worldMinX: 0, worldMinY: 0, scale: 1, offsetX: 0, offsetY: 0,
    zoomLevel: 1, containerWidth: 0, containerHeight: 0,
  })
  const [corner, setCorner] = useState<Corner>(loadCorner)
  const [size, setSize] = useState<{ w: number; h: number }>(loadSize)
  // Popover mode fills its host (width/height 100%), so the fit-scale must use the
  // host's real pixel size rather than a fixed guess — measured here so the map
  // scales to whatever card the palette gives it. Seeded with a sane default.
  const [popoverSize, setPopoverSize] = useState<{ w: number; h: number }>({ w: 218, h: 158 })
  const MINIMAP_WIDTH = mode === 'popover' ? popoverSize.w : size.w
  const MINIMAP_HEIGHT = mode === 'popover' ? popoverSize.h : size.h

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
        useUIStateStore.getState().setUIState('minimapSize', { w, h })
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
          useUIStateStore.getState().setUIState('minimapCorner', next)
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
    const { worldMinX, worldMinY, scale, offsetX, offsetY } = layoutRef.current
    const rect = minimapRef.current.getBoundingClientRect()

    const navigate = (clientX: number, clientY: number) => {
      const state = canvasApi.getState()
      const canvasX = (clientX - rect.left - MINIMAP_PADDING - offsetX) / scale + worldMinX
      const canvasY = (clientY - rect.top - MINIMAP_PADDING - offsetY) / scale + worldMinY
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
      onNavigateEnd?.()
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
  }, [canvasApi, onNavigateEnd])

  // Track the popover host's real size so the fit-scale matches the rendered box.
  useEffect(() => {
    if (mode !== 'popover') return
    const el = minimapRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    // Measure WIDTH only — popover height is derived from content aspect below
    // (the div sets its own height), so reading it back would feed a loop.
    const measure = () => {
      const w = Math.round(el.getBoundingClientRect().width)
      if (w > 0) setPopoverSize((prev) => (prev.w === w ? prev : { ...prev, w }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [mode, nodeList.length])

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
    const minX = Math.min(...nodeList.map(n => n.origin.x))
    const minY = Math.min(...nodeList.map(n => n.origin.y))
    const maxX = Math.max(...nodeList.map(n => n.origin.x + n.size.width))
    const maxY = Math.max(...nodeList.map(n => n.origin.y + n.size.height))
    return { minX, minY, maxX, maxY }
  }, [nodeList])

  if (!contentBounds) return null

  const { minX, minY, maxX, maxY } = contentBounds
  const isPopover = mode === 'popover'

  // Seed world bounds from current offset (used for initial render and re-renders on zoom/node change)
  const seedOffset = canvasApi.getState().viewportOffset
  const vpLeft0 = -seedOffset.x / zoomLevel
  const vpTop0 = -seedOffset.y / zoomLevel
  const vpRight0 = vpLeft0 + containerSize.width / zoomLevel
  const vpBottom0 = vpTop0 + containerSize.height / zoomLevel

  // Floating mode frames the content AND the current viewport (the view rect is
  // always kept visible). Popover mode is a pure content overview that fills the
  // card: it frames only the nodes (a small margin) and omits the view rect.
  const margin = isPopover ? 60 : 100
  const worldMinX = (isPopover ? minX : Math.min(minX, vpLeft0)) - margin
  const worldMinY = (isPopover ? minY : Math.min(minY, vpTop0)) - margin
  const worldMaxX = (isPopover ? maxX : Math.max(maxX, vpRight0)) + margin
  const worldMaxY = (isPopover ? maxY : Math.max(maxY, vpBottom0)) + margin

  const worldW = worldMaxX - worldMinX
  const worldH = worldMaxY - worldMinY

  const innerW = MINIMAP_WIDTH - MINIMAP_PADDING * 2

  // Floating: fixed box, fit both axes. Popover: fill the card WIDTH and grow the
  // card height to the content's aspect (capped) so the map spans edge-to-edge
  // without cropping any node; only very tall canvases fall back to fit-both
  // within the cap. `popoverHeight` drives the (auto-height) card.
  const POPOVER_MAX_H = 360
  const POPOVER_MIN_H = 140
  let scale: number
  let popoverHeight = MINIMAP_HEIGHT
  if (isPopover) {
    scale = innerW / worldW
    popoverHeight = worldH * scale + MINIMAP_PADDING * 2
    if (popoverHeight > POPOVER_MAX_H) {
      popoverHeight = POPOVER_MAX_H
      scale = Math.min(innerW / worldW, (POPOVER_MAX_H - MINIMAP_PADDING * 2) / worldH)
    }
    popoverHeight = Math.max(popoverHeight, POPOVER_MIN_H)
  } else {
    scale = Math.min(innerW / worldW, (MINIMAP_HEIGHT - MINIMAP_PADDING * 2) / worldH)
  }
  // Center within the resolved box (no-op on the axis the fit is tight against).
  const innerHFinal = (isPopover ? popoverHeight : MINIMAP_HEIGHT) - MINIMAP_PADDING * 2
  const offsetX = isPopover ? (innerW - worldW * scale) / 2 : 0
  const offsetY = isPopover ? (innerHFinal - worldH * scale) / 2 : 0

  const toMiniX = (x: number) => MINIMAP_PADDING + (x - worldMinX) * scale + offsetX
  const toMiniY = (y: number) => MINIMAP_PADDING + (y - worldMinY) * scale + offsetY

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
    offsetX,
    offsetY,
    zoomLevel,
    containerWidth: containerSize.width,
    containerHeight: containerSize.height,
  }

  return (
    <div
      ref={minimapRef}
      style={{
        ...(isPopover
          ? { position: 'relative' as const, width: '100%', height: popoverHeight }
          : {
              position: 'absolute' as const,
              ...(corner.startsWith('bottom') ? { bottom: MINIMAP_GAP } : { top: MINIMAP_GAP }),
              ...(corner.endsWith('right') ? { right: MINIMAP_GAP } : { left: MINIMAP_GAP }),
              opacity: 0.7,
              zIndex: 20,
              width: MINIMAP_WIDTH,
              height: MINIMAP_HEIGHT,
            }),
        backgroundColor: isPopover ? 'transparent' : 'var(--surface-2)',
        borderRadius: isPopover ? 6 : 8,
        border: isPopover ? 'none' : `1px solid var(--border-subtle)`,
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

      {/* Node rectangles */}
      {nodeList.map((node) => {
        const panelId = activeDockPanelId(node.dockLayout)
        const panel = panelId ? panels?.[panelId] : undefined
        const type = panel?.type || 'terminal'
        const rectW = Math.max(node.size.width * scale, 2)
        const rectH = Math.max(node.size.height * scale, 2)
        // Show the agent logo when an agent is open in this panel's terminal.
        const agentLogo = panelId ? agentInfoByPanel[panelId]?.logo ?? null : null
        const iconSize = Math.min(rectW, rectH) - 2
        // Outline the rect in its worktree color (if any) so each panel reads
        // as belonging to a branch.
        const worktreeColor = nodeColorById[node.id]
        return (
          <div
            key={node.id}
            onMouseDown={(e) => {
              e.stopPropagation()
              e.preventDefault()
              canvasApi.getState().focusAndCenter(node.id)
              onNavigateEnd?.()
            }}
            style={{
              position: 'absolute',
              left: toMiniX(node.origin.x),
              top: toMiniY(node.origin.y),
              width: rectW,
              height: rectH,
              backgroundColor: themedPanelColor(type),
              // Worktree color as a 2px ring drawn outside the rect, so it stays
              // visible without eating into the small panel fill.
              boxShadow: worktreeColor ? `0 0 0 2px ${worktreeColor}` : undefined,
              boxSizing: 'border-box',
              borderRadius: 1,
              opacity: 1,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
            }}
          >
            {agentLogo && iconSize >= 6 && (
              <img
                src={agentLogo}
                alt=""
                draggable={false}
                style={{
                  width: Math.min(iconSize, 16),
                  height: Math.min(iconSize, 16),
                  objectFit: 'contain',
                  pointerEvents: 'none',
                }}
              />
            )}
          </div>
        )
      })}

      {/* Viewport rectangle — position is updated imperatively by canvasApi.subscribe.
          Omitted in popover mode: the palette overview is a pure content map, so
          the framing rectangle would just read as an unwanted border. */}
      {!isPopover && (
        <div
          ref={viewportRectRef}
          style={{
            position: 'absolute',
            left: vpRectLeft,
            top: vpRectTop,
            width: vpRectWidth,
            height: vpRectHeight,
            border: `var(--hairline) solid var(--border-strong)`,
            borderRadius: 2,
            pointerEvents: 'none',
          }}
        />
      )}
    </div>
  )
}

export default React.memo(Minimap)
