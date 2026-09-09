// =============================================================================
// Minimap — Bird's-eye overview of all panels on the canvas.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { useCanvasStoreContext, useCanvasStoreApi, shallow } from '../stores/CanvasStoreContext'
import { useWorkspacePanels, useAppStore } from '../stores/appStore'
import { useAgentInfoByPanel } from '../hooks/useAgentPanelInfo'
import { useWorktreeMembership } from './worktree/useWorktreeMembership'
import { getSharedPanelDef } from '../../shared/panels'
import { activeDockPanelId } from '../../shared/collectPanelIds'

const MINIMAP_PADDING = 10
const MINIMAP_WIDTH = 218
const MINIMAP_HEIGHT = 158

// Keep theme overrides while giving every registered surface its own color.
function themedPanelColor(panelType: string): string {
  const definition = getSharedPanelDef(panelType)
  return `var(--panel-${definition.type}, ${definition.mutedColor})`
}

const Minimap: React.FC = () => {
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
    worldMinX: 0, worldMinY: 0, scale: 1,
    zoomLevel: 1, containerWidth: 0, containerHeight: 0,
  })
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
    const minX = Math.min(...nodeList.map(n => n.origin.x))
    const minY = Math.min(...nodeList.map(n => n.origin.y))
    const maxX = Math.max(...nodeList.map(n => n.origin.x + n.size.width))
    const maxY = Math.max(...nodeList.map(n => n.origin.y + n.size.height))
    return { minX, minY, maxX, maxY }
  }, [nodeList])

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

  return (
    <div
      ref={minimapRef}
      style={{
        position: 'relative', width: '100%', height: '100%',
        backgroundColor: 'transparent',
        borderRadius: 6,
        border: 'none',
        overflow: 'hidden',
        cursor: 'crosshair',
      }}
      onMouseDown={handleMouseDown}
    >
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
