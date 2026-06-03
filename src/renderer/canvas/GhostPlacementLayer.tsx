// =============================================================================
// GhostPlacementLayer — interactive recommendation ghosts for new-node placement.
//
// When a create action is deferred (canvasStore.pendingPlacement is set), the
// canvas zooms out and this renders, inside the world div:
//   - a dim "placement surface" scrim that focuses attention and doubles as the
//     escape hatch — hovering it previews a free spot, clicking it drops there
//     ("none of these fit? click anywhere");
//   - 3–5 numbered recommendation ghosts (the smart picks);
// plus a fixed hint pill (portalled to <body>) with the controls.
//
// Pick by clicking a ghost, pressing its number (1..N), Enter (best), or clicking
// anywhere on the canvas. Esc / the Cancel button cancels.
// =============================================================================

import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useCanvasStoreContext, useCanvasStoreApi } from '../stores/CanvasStoreContext'

const ACCENT = '74, 158, 255'

// Inject the entrance keyframes once.
let stylesInjected = false
function injectStyles() {
  if (stylesInjected || typeof document === 'undefined') return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    @keyframes ghostIn { from { opacity: 0; transform: scale(0.94); } to { opacity: 1; transform: scale(1); } }
    @keyframes ghostHintIn { from { opacity: 0; transform: translate(-50%, -8px); } to { opacity: 1; transform: translate(-50%, 0); } }
  `
  document.head.appendChild(style)
}

const GhostPlacementLayer: React.FC = () => {
  const pending = useCanvasStoreContext((s) => s.pendingPlacement)
  const zoom = useCanvasStoreContext((s) => s.zoomLevel)
  const api = useCanvasStoreApi()

  const count = pending?.candidates.length ?? 0

  useEffect(injectStyles, [])

  // Keyboard commit/cancel — active only while a placement is pending. Capture
  // phase so digits/Enter/Esc are intercepted before panel content sees them.
  useEffect(() => {
    if (!pending) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation()
        api.getState().cancelPlacement()
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation()
        api.getState().commitPlacement(0)
        return
      }
      const n = Number(e.key)
      if (Number.isInteger(n) && n >= 1 && n <= count) {
        e.preventDefault(); e.stopPropagation()
        api.getState().commitPlacement(n - 1)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [pending, count, api])

  // rAF-throttled free-placement cursor tracking on the surface.
  const moveRaf = useRef(0)
  const lastClient = useRef<{ x: number; y: number; el: HTMLElement } | null>(null)
  useEffect(() => () => { if (moveRaf.current) cancelAnimationFrame(moveRaf.current) }, [])

  if (!pending) return null

  const toCanvas = (clientX: number, clientY: number, el: HTMLElement) => {
    const container = el.closest('[data-canvas-container]') as HTMLElement | null
    if (!container) return null
    const rect = container.getBoundingClientRect()
    return api.getState().viewToCanvas({ x: clientX - rect.left, y: clientY - rect.top })
  }
  const flushMove = () => {
    moveRaf.current = 0
    const d = lastClient.current
    if (!d) return
    const pt = toCanvas(d.x, d.y, d.el)
    if (pt) api.getState().updatePlacementCursor(pt)
  }
  const onSurfaceMove = (e: React.MouseEvent<HTMLDivElement>) => {
    lastClient.current = { x: e.clientX, y: e.clientY, el: e.currentTarget }
    if (!moveRaf.current) moveRaf.current = requestAnimationFrame(flushMove)
  }
  const onSurfaceClick = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation()
    const pt = toCanvas(e.clientX, e.clientY, e.currentTarget)
    if (pt) api.getState().commitFreePlacement(pt)
  }

  // Counter-scale the badge so it stays a constant on-screen size at any zoom.
  const badgeScale = 1 / Math.max(zoom, 0.6)
  const free = pending.hoveredIndex == null ? pending.freeGhost : null

  return (
    <>
      {/* Dim placement surface — focuses attention + click-anywhere escape hatch. */}
      <div
        data-placement-surface
        onMouseMove={onSurfaceMove}
        onMouseLeave={() => api.getState().updatePlacementCursor({ x: -1e6, y: -1e6 })}
        onClick={onSurfaceClick}
        style={{
          position: 'absolute',
          left: -100000, top: -100000, width: 200000, height: 200000,
          zIndex: 40000,
          background: 'rgba(8, 12, 20, 0.34)',
          cursor: 'crosshair',
          pointerEvents: 'auto',
        }}
      />

      {/* Free-placement preview ghost (where a click would land). */}
      {free && (
        <div
          style={{
            position: 'absolute',
            left: free.point.x, top: free.point.y,
            width: free.size.width, height: free.size.height,
            border: `1.5px dashed rgba(${ACCENT}, 0.6)`,
            borderRadius: 8,
            background: `rgba(${ACCENT}, 0.06)`,
            zIndex: 49000,
            pointerEvents: 'none',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div style={{ transform: `scale(${badgeScale})`, padding: '3px 10px', borderRadius: 6,
            background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: 11, fontWeight: 500,
            fontFamily: 'system-ui, -apple-system, sans-serif', whiteSpace: 'nowrap', userSelect: 'none' }}>
            Place here
          </div>
        </div>
      )}

      {pending.candidates.map((c, i) => {
        const hovered = pending.hoveredIndex === i
        const isBest = i === 0
        return (
          <div
            key={i}
            data-ghost-candidate={i}
            onClick={(e) => { e.stopPropagation(); api.getState().commitPlacement(i) }}
            onMouseEnter={() => api.getState().setPlacementHover(i)}
            onMouseLeave={() => api.getState().setPlacementHover(null)}
            style={{
              position: 'absolute',
              left: c.point.x, top: c.point.y,
              width: c.size.width, height: c.size.height,
              border: `${isBest ? 2.5 : 1.5}px solid rgba(${ACCENT}, ${hovered || isBest ? 0.95 : 0.6})`,
              borderRadius: 8,
              background: `rgba(${ACCENT}, ${hovered ? 0.2 : isBest ? 0.13 : 0.08})`,
              boxShadow: hovered
                ? `0 12px 32px rgba(0,0,0,0.4), 0 0 0 4px rgba(${ACCENT}, 0.18)`
                : isBest ? '0 8px 24px rgba(0,0,0,0.32)' : undefined,
              cursor: 'pointer',
              pointerEvents: 'auto',
              zIndex: 50000 + (hovered ? 500 : i),
              animation: `ghostIn 160ms ease ${i * 35}ms both`,
              transition: 'background 120ms ease, border-color 120ms ease, box-shadow 120ms ease',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <div
              style={{
                transform: `scale(${badgeScale})`,
                transformOrigin: 'center',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                userSelect: 'none',
              }}
            >
              <div
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 42, height: 42, borderRadius: 21,
                  background: `rgba(${ACCENT}, ${hovered || isBest ? 1 : 0.85})`,
                  color: '#fff', fontWeight: 700, fontSize: 19,
                  fontFamily: 'system-ui, -apple-system, sans-serif',
                  boxShadow: '0 3px 10px rgba(0,0,0,0.35)',
                }}
              >
                {i + 1}
              </div>
              {isBest && (
                <div style={{ padding: '2px 8px', borderRadius: 6, background: `rgba(${ACCENT}, 0.95)`,
                  color: '#fff', fontSize: 10.5, fontWeight: 600, letterSpacing: 0.3,
                  fontFamily: 'system-ui, -apple-system, sans-serif', textTransform: 'uppercase' }}>
                  Best
                </div>
              )}
            </div>
          </div>
        )
      })}

      <HintPill onCancel={() => api.getState().cancelPlacement()} count={count} />
    </>
  )
}

// Fixed instruction pill, portalled to <body> so it sits in screen space.
const HintPill: React.FC<{ onCancel: () => void; count: number }> = ({ onCancel, count }) => {
  const body = typeof document !== 'undefined' ? document.body : null
  if (!body) return null
  return createPortal(
    <div
      style={{
        position: 'fixed', left: '50%', top: 24, transform: 'translateX(-50%)',
        zIndex: 2147483000,
        display: 'flex', alignItems: 'center', gap: 14,
        padding: '9px 9px 9px 16px', borderRadius: 999,
        background: 'rgba(20, 24, 32, 0.92)',
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
        color: 'rgba(255,255,255,0.92)', fontSize: 13, fontWeight: 500,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
        animation: 'ghostHintIn 200ms ease both',
        userSelect: 'none',
      }}
    >
      <span>
        Pick a spot — press <Kbd>1</Kbd>–<Kbd>{count}</Kbd>, or click any ghost or empty space
      </span>
      <button
        onClick={onCancel}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '5px 12px', borderRadius: 999, border: 'none', cursor: 'pointer',
          background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.9)',
          fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
        }}
      >
        Cancel <Kbd>Esc</Kbd>
      </button>
    </div>,
    body,
  )
}

const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <kbd style={{
    display: 'inline-block', minWidth: 18, padding: '1px 5px', margin: '0 1px',
    borderRadius: 5, background: 'rgba(255,255,255,0.14)',
    border: '1px solid rgba(255,255,255,0.12)', borderBottomWidth: 2,
    fontSize: 11, fontWeight: 600, textAlign: 'center', lineHeight: '16px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  }}>
    {children}
  </kbd>
)

export default React.memo(GhostPlacementLayer)
