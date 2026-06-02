// =============================================================================
// GhostPlacementLayer — interactive "ghost" previews for new-node placement.
// When a create action defers placement (canvasStore.pendingPlacement is set),
// this renders one translucent, clickable ghost per candidate spot inside the
// canvas world div. The user commits by clicking a ghost, pressing its number
// (1..N), or Enter (best-ranked); Esc cancels. Modeled on RegionsLayer.
// =============================================================================

import React, { useEffect } from 'react'
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

  if (!pending) return null

  // Counter-scale the badge so it stays a constant on-screen size at any zoom.
  const badgeScale = 1 / Math.max(zoom, 0.6)

  return (
    <>
      {pending.candidates.map((c, i) => {
        const hovered = pending.hoveredIndex === i
        const isBest = i === 0
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
              width: pending.size.width,
              height: pending.size.height,
              border: `${isBest ? 2 : 1.5}px ${isBest ? 'solid' : 'dashed'} rgba(${ACCENT}, ${hovered ? 0.95 : 0.7})`,
              borderRadius: 8,
              background: `rgba(${ACCENT}, ${hovered ? 0.16 : 0.08})`,
              boxShadow: hovered ? '0 8px 24px var(--shadow-node)' : undefined,
              cursor: 'pointer',
              pointerEvents: 'auto',
              zIndex: 50000 + i,
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
                alignItems: 'center',
                justifyContent: 'center',
                width: 34,
                height: 34,
                borderRadius: 17,
                background: `rgba(${ACCENT}, ${hovered ? 1 : 0.9})`,
                color: '#fff',
                fontWeight: 600,
                fontSize: 16,
                fontFamily: 'system-ui, -apple-system, sans-serif',
                userSelect: 'none',
                boxShadow: '0 2px 6px rgba(0, 0, 0, 0.25)',
              }}
            >
              {i + 1}
            </div>
          </div>
        )
      })}
    </>
  )
}

export default React.memo(GhostPlacementLayer)
