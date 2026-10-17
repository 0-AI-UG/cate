// Bird's-eye overview of every node on the canvas. The viewport rectangle
// moves imperatively on pan, so panning never re-renders the map.

import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { useClientState, useDocument } from '../../document'
import type { WorkspaceDocument } from '@workspace/document/contract'
import { activeNodePanelId } from './store'
import { shallowArrayEqual, useCanvasView, useCanvasViewStore } from './context'
import { useWorktreeMembership } from './worktree'
import { useTabDecorations } from '../dock'

const selectPanels = (doc: WorkspaceDocument) => doc.panels

const MINIMAP_PADDING = 10
const MINIMAP_WIDTH = 218
const MINIMAP_HEIGHT = 158

// The theme colors each panel type through `--panel-<type>`; a node without
// a shown panel is neutral.
function themedPanelColor(panelType: string | undefined): string {
  return panelType ? `var(--panel-${panelType}, var(--surface-4))` : 'var(--surface-4)'
}

function Minimap({ workspaceId }: { workspaceId: string }) {
  const nodeList = useCanvasView((s) => Object.values(s.nodes), shallowArrayEqual)
  const zoomLevel = useCanvasView((s) => s.zoomLevel)
  const containerSize = useCanvasView(
    (s) => s.containerSize,
    (a, b) => a.width === b.width && a.height === b.height,
  )
  const panels = useDocument(workspaceId, selectPanels)
  const activeTabs = useClientState(workspaceId, (s) => s.activeTabs)
  const decorations = useTabDecorations(workspaceId)
  // The same membership the territory draws, so the two never disagree.
  const { groups } = useWorktreeMembership(workspaceId)
  // nodeId → worktree color, so each node rect can carry its branch color.
  const nodeColorById = useMemo(() => {
    const map: Record<string, string> = {}
    for (const g of groups) for (const id of g.nodeIds) map[id] = g.color
    return map
  }, [groups])
  const canvasApi = useCanvasViewStore()
  const minimapRef = useRef<HTMLDivElement>(null)
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
    // for the whole drag; otherwise each mousemove re-derives bounds that include
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
        const panelId = activeNodePanelId(node.dock, activeTabs)
        const panel = panelId ? panels[panelId] : undefined
        const type = panel?.type
        const rectW = Math.max(node.size.width * scale, 2)
        const rectH = Math.max(node.size.height * scale, 2)
        // The logo its tab shows in place of the type icon, if any.
        const logo = panelId ? decorations[panelId]?.logo ?? null : null
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
            {logo && iconSize >= 6 && (
              <img
                src={logo}
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

      {/* Moved imperatively on pan by the subscription above. */}
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
