// =============================================================================
// GhostPlacementLayer — interactive "ghost" previews for new-node placement.
//
// While a create action is deferred (canvasStore.pendingPlacement is set) this
// renders, inside the canvas world div:
//   - a full-bleed "placement surface" that tracks the cursor (re-anchoring the
//     ghost cluster live as the mouse moves) and commits the primary ghost on
//     click — so the whole canvas becomes "click anywhere to drop here";
//   - the cursor-anchored cluster of ghosts (candidates[0] is the primary
//     "drop here" spot; the rest are alternate shapes tucked beside it).
// Commit via click, number keys 1..N, or Enter (primary). Esc cancels.
// =============================================================================

import React, { useEffect, useRef } from 'react'
import { useCanvasStoreContext, useCanvasStoreApi } from '../stores/CanvasStoreContext'

const ACCENT = '74, 158, 255'

const GhostPlacementLayer: React.FC = () => {
  const pending = useCanvasStoreContext((s) => s.pendingPlacement)
  const zoom = useCanvasStoreContext((s) => s.zoomLevel)
  const api = useCanvasStoreApi()

  const count = pending?.candidates.length ?? 0

  // Keyboard commit/cancel — active only while a placement is pending. Capture
  // phase so digits/Enter/Esc are intercepted before panel content sees them.
  useEffect(() => {
    if (!pending) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        api.getState().cancelPlacement()
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        api.getState().commitPlacement(0)
        return
      }
      const n = Number(e.key)
      if (Number.isInteger(n) && n >= 1 && n <= count) {
        e.preventDefault()
        e.stopPropagation()
        api.getState().commitPlacement(n - 1)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [pending, count, api])

  // rAF-throttled cursor follow for the placement surface.
  const moveRaf = useRef(0)
  const pendingClient = useRef<{ x: number; y: number; el: HTMLElement } | null>(null)
  useEffect(() => () => { if (moveRaf.current) cancelAnimationFrame(moveRaf.current) }, [])

  if (!pending) return null

  const flushCursor = () => {
    moveRaf.current = 0
    const data = pendingClient.current
    if (!data) return
    const container = data.el.closest('[data-canvas-container]') as HTMLElement | null
    if (!container) return
    const rect = container.getBoundingClientRect()
    const canvasPt = api.getState().viewToCanvas({ x: data.x - rect.left, y: data.y - rect.top })
    api.getState().updatePlacementCursor(canvasPt)
  }
  const onSurfaceMove = (e: React.MouseEvent<HTMLDivElement>) => {
    pendingClient.current = { x: e.clientX, y: e.clientY, el: e.currentTarget }
    if (!moveRaf.current) moveRaf.current = requestAnimationFrame(flushCursor)
  }

  // Counter-scale the badge so it stays a constant on-screen size at any zoom.
  const badgeScale = 1 / Math.max(zoom, 0.6)

  return (
    <>
      {/* Placement surface: covers the whole canvas above nodes, below ghosts.
          Tracks the cursor and drops the primary ghost on click. */}
      <div
        data-placement-surface
        onMouseMove={onSurfaceMove}
        onClick={(e) => {
          e.stopPropagation()
          api.getState().commitPlacement(0)
        }}
        style={{
          position: 'absolute',
          left: -100000,
          top: -100000,
          width: 200000,
          height: 200000,
          zIndex: 40000,
          cursor: 'crosshair',
          pointerEvents: 'auto',
        }}
      />

      {pending.candidates.map((c, i) => {
        const hovered = pending.hoveredIndex === i
        const isPrimary = i === 0
        return (
          <div
            key={i}
            data-ghost-candidate={i}
            onClick={(e) => {
              e.stopPropagation()
              api.getState().commitPlacement(i)
            }}
            onMouseEnter={() => api.getState().setPlacementHover(i)}
            onMouseLeave={() => api.getState().setPlacementHover(null)}
            style={{
              position: 'absolute',
              left: c.point.x,
              top: c.point.y,
              width: c.size.width,
              height: c.size.height,
              border: `${isPrimary ? 2.5 : 1.5}px ${isPrimary ? 'solid' : 'dashed'} rgba(${ACCENT}, ${hovered || isPrimary ? 0.95 : 0.65})`,
              borderRadius: 8,
              background: `rgba(${ACCENT}, ${hovered ? 0.18 : isPrimary ? 0.12 : 0.07})`,
              boxShadow: hovered || isPrimary ? '0 8px 24px var(--shadow-node)' : undefined,
              cursor: 'pointer',
              pointerEvents: 'auto',
              zIndex: 50000 + (isPrimary ? 100 : i),
              transition: 'background 120ms ease, border-color 120ms ease',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div
              style={{
                transform: `scale(${badgeScale})`,
                transformOrigin: 'center',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 6,
                userSelect: 'none',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 34,
                  height: 34,
                  borderRadius: 17,
                  background: `rgba(${ACCENT}, ${hovered || isPrimary ? 1 : 0.85})`,
                  color: '#fff',
                  fontWeight: 600,
                  fontSize: 16,
                  fontFamily: 'system-ui, -apple-system, sans-serif',
                  boxShadow: '0 2px 6px rgba(0, 0, 0, 0.25)',
                }}
              >
                {i + 1}
              </div>
              <div
                style={{
                  padding: '2px 8px',
                  borderRadius: 6,
                  background: 'rgba(0, 0, 0, 0.6)',
                  color: '#fff',
                  fontSize: 11,
                  fontWeight: 500,
                  fontFamily: 'system-ui, -apple-system, sans-serif',
                  whiteSpace: 'nowrap',
                }}
              >
                {isPrimary ? 'Drop here' : c.sizeLabel}
              </div>
            </div>
          </div>
        )
      })}
    </>
  )
}

export default React.memo(GhostPlacementLayer)
