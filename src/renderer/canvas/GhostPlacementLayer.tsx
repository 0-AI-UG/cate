// =============================================================================
// GhostPlacementLayer — interactive recommendation ghosts for new-node placement.
//
// When a create action is deferred (canvasStore.pendingPlacement is set), the
// canvas zooms out and this renders, inside the world div:
//   - a transparent "placement surface" covering the canvas: clicking empty
//     space cancels (unless free mode is armed), and — once the user presses F
//     to arm free placement — it previews/drops a "Place here" ghost at the
//     cursor ("none of these fit? press F, then click anywhere");
//   - 3–5 numbered recommendation ghosts (the smart picks).
// The hint pill + app dim are rendered by Canvas (screen space). Pick by clicking
// a ghost, pressing its number (1..N), or Enter (best). Esc cancels.
// =============================================================================

import React, { useEffect, useRef } from 'react'
import { useCanvasStoreContext, useCanvasStoreApi } from '../stores/CanvasStoreContext'

// Theme accent — ghosts track the active theme's --focus-blue rather than a
// hardcoded blue, so they recolor with the IDE theme. color-mix gives us a
// per-stop alpha (the same technique the dock drop-target ghosts use in
// DockTabBar). `accent(100)` is the solid accent.
const accent = (pct: number) => `color-mix(in srgb, var(--focus-blue) ${pct}%, transparent)`

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

  // Keyboard: digits / Enter commit, F arms free placement, Esc cancels.
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
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault(); e.stopPropagation()
        const p = api.getState().pendingPlacement
        if (p) api.getState().setFreeArmed(!p.freeArmed)
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

  const armed = pending.freeArmed
  const toCanvas = (clientX: number, clientY: number, el: HTMLElement) => {
    const container = el.closest('[data-canvas-container]') as HTMLElement | null
    if (!container) return null
    const rect = container.getBoundingClientRect()
    return api.getState().viewToCanvas({ x: clientX - rect.left, y: clientY - rect.top })
  }
  const flushMove = () => {
    moveRaf.current = 0
    const d = lastClient.current
    if (!d || !api.getState().pendingPlacement?.freeArmed) return
    const pt = toCanvas(d.x, d.y, d.el)
    if (pt) api.getState().updatePlacementCursor(pt)
  }
  const onSurfaceMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!armed) return
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
  const free = armed && pending.hoveredIndex == null ? pending.freeGhost : null

  return (
    <>
      {/* Free "place anywhere" surface — only while armed (press F); otherwise
          the app stays fully interactive and the ghosts are picked directly. */}
      {armed && (
        <div
          data-placement-surface
          onMouseMove={onSurfaceMove}
          onClick={onSurfaceClick}
          style={{
            position: 'absolute',
            left: -100000, top: -100000, width: 200000, height: 200000,
            zIndex: 40000, cursor: 'crosshair', pointerEvents: 'auto',
          }}
        />
      )}

      {/* Free-placement preview ghost (only while armed). */}
      {free && (
        <div
          style={{
            position: 'absolute',
            left: free.point.x, top: free.point.y,
            width: free.size.width, height: free.size.height,
            border: `1.5px dashed ${accent(70)}`,
            borderRadius: 8,
            background: accent(8),
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
              border: `${isBest ? 2.5 : 1.5}px solid ${accent(hovered || isBest ? 95 : 60)}`,
              borderRadius: 8,
              background: accent(hovered ? 20 : isBest ? 13 : 8),
              boxShadow: hovered
                ? `0 12px 32px rgba(0,0,0,0.4), 0 0 0 4px ${accent(18)}`
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
                  background: accent(hovered || isBest ? 100 : 85),
                  color: '#fff', fontWeight: 700, fontSize: 19,
                  fontFamily: 'system-ui, -apple-system, sans-serif',
                  boxShadow: '0 3px 10px rgba(0,0,0,0.35)',
                }}
              >
                {i + 1}
              </div>
              {isBest && (
                <div style={{ padding: '2px 8px', borderRadius: 6, background: accent(95),
                  color: '#fff', fontSize: 10.5, fontWeight: 600, letterSpacing: 0.3,
                  fontFamily: 'system-ui, -apple-system, sans-serif', textTransform: 'uppercase' }}>
                  Best
                </div>
              )}
            </div>
          </div>
        )
      })}
    </>
  )
}

export default React.memo(GhostPlacementLayer)
