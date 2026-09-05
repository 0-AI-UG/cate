// One canvas overlay for every interactive panel-target request: recommended
// new positions, free placement, eligible existing panels, or any combination.

import React, { useEffect, useMemo, useRef } from 'react'
import { useCanvasStoreApi, useCanvasStoreContext } from '../stores/CanvasStoreContext'
import { focusedNodeId as focusedNodeIdOf } from '../stores/canvas/selectionModel'

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

const PanelTargetLayer: React.FC<{ canvasRef?: React.RefObject<HTMLDivElement> }> = ({ canvasRef }) => {
  const pending = useCanvasStoreContext((state) => state.pendingPanelTarget)
  const nodes = useCanvasStoreContext((state) => state.nodes)
  const focusedId = useCanvasStoreContext((state) => focusedNodeIdOf(state))
  const zoom = useCanvasStoreContext((state) => state.zoomLevel)
  const api = useCanvasStoreApi()

  const choices = useMemo(() => pending
    ? [
        ...pending.candidates.map((_, index) => ({ kind: 'new' as const, index })),
        ...pending.existing.map((candidate) => ({ kind: 'existing' as const, panelId: candidate.panelId })),
      ]
    : [], [pending])

  useEffect(injectStyles, [])

  const lastFocus = useRef<string | null>(null)
  const wasPending = useRef(false)
  useEffect(() => {
    if (!pending) {
      wasPending.current = false
      return
    }
    if (!wasPending.current) {
      wasPending.current = true
      lastFocus.current = focusedId
      return
    }
    if (focusedId !== lastFocus.current) {
      lastFocus.current = focusedId
      if (focusedId !== null) api.getState().refreshPlacement()
    }
  }, [pending, focusedId, api])

  useEffect(() => {
    if (!pending) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        api.getState().cancelPanelTarget()
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        const first = choices[0]
        if (first?.kind === 'new') api.getState().selectNewPanelTarget(first.index)
        else if (first) api.getState().selectExistingPanelTarget(first.panelId)
        return
      }
      if ((event.key === 'f' || event.key === 'F') && pending.availability !== 'existing') {
        event.preventDefault()
        event.stopPropagation()
        const current = api.getState().pendingPanelTarget
        if (current) api.getState().setFreeArmed(!current.freeArmed)
        return
      }
      const number = Number(event.key)
      if (!Number.isInteger(number) || number < 1 || number > Math.min(choices.length, 9)) return
      event.preventDefault()
      event.stopPropagation()
      const choice = choices[number - 1]
      if (choice.kind === 'new') api.getState().selectNewPanelTarget(choice.index)
      else api.getState().selectExistingPanelTarget(choice.panelId)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [pending, choices, api])

  const moveRaf = useRef(0)
  const lastClient = useRef<{ x: number; y: number; el: HTMLElement } | null>(null)
  useEffect(() => () => {
    if (moveRaf.current) cancelAnimationFrame(moveRaf.current)
  }, [])

  if (!pending) return null

  const armed = pending.freeArmed
  const toCanvas = (clientX: number, clientY: number, element: HTMLElement) => {
    const container = canvasRef?.current
      ?? element.closest('[data-canvas-container]') as HTMLElement | null
    if (!container) return null
    const rect = container.getBoundingClientRect()
    return api.getState().viewToCanvas({ x: clientX - rect.left, y: clientY - rect.top })
  }
  const flushMove = () => {
    moveRaf.current = 0
    const latest = lastClient.current
    if (!latest || !api.getState().pendingPanelTarget?.freeArmed) return
    const point = toCanvas(latest.x, latest.y, latest.el)
    if (point) api.getState().updatePlacementCursor(point)
  }
  const onSurfaceMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!armed) return
    lastClient.current = { x: event.clientX, y: event.clientY, el: event.currentTarget }
    if (!moveRaf.current) moveRaf.current = requestAnimationFrame(flushMove)
  }
  const onSurfaceClick = (event: React.MouseEvent<HTMLDivElement>) => {
    event.stopPropagation()
    const point = toCanvas(event.clientX, event.clientY, event.currentTarget)
    if (point) api.getState().commitFreePlacement(point)
  }

  const badgeScale = 1 / Math.max(zoom, 0.6)
  const free = armed && pending.hoveredIndex == null ? pending.freeGhost : null
  const byNode = new Map<string, typeof pending.existing>()
  for (const candidate of pending.existing) {
    byNode.set(candidate.nodeId, [...(byNode.get(candidate.nodeId) ?? []), candidate])
  }

  return (
    <>
      {armed && (
        <div
          data-placement-surface
          onMouseMove={onSurfaceMove}
          onClick={onSurfaceClick}
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
      )}

      {free && (
        <div style={{
          position: 'absolute',
          left: free.point.x,
          top: free.point.y,
          width: free.size.width,
          height: free.size.height,
          border: `1.5px dashed ${accent(70)}`,
          borderRadius: 8,
          background: accent(8),
          zIndex: 49000,
          pointerEvents: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <div style={{
            transform: `scale(${badgeScale})`,
            padding: '3px 10px',
            borderRadius: 6,
            background: 'rgba(0,0,0,0.6)',
            color: '#fff',
            fontSize: 11,
            fontWeight: 500,
            fontFamily: 'var(--font-sans)',
            whiteSpace: 'nowrap',
            userSelect: 'none',
          }}>
            Place here
          </div>
        </div>
      )}

      {pending.candidates.map((candidate, index) => {
        const hovered = pending.hoveredIndex === index
        const isBest = index === 0
        return (
          <button
            key={`new-${index}`}
            type="button"
            data-panel-target
            data-ghost-candidate={index}
            aria-label={`Create new ${pending.panelType} at position ${index + 1}`}
            onClick={(event) => {
              event.stopPropagation()
              api.getState().selectNewPanelTarget(index)
            }}
            onMouseEnter={() => api.getState().setPlacementHover(index)}
            onMouseLeave={() => api.getState().setPlacementHover(null)}
            style={{
              position: 'absolute',
              left: candidate.point.x,
              top: candidate.point.y,
              width: candidate.size.width,
              height: candidate.size.height,
              border: `${isBest ? 2.5 : 1.5}px ${pending.existing.length > 0 ? 'dashed' : 'solid'} ${accent(hovered || isBest ? 95 : 60)}`,
              borderRadius: 8,
              background: accent(hovered ? 20 : isBest ? 13 : 8),
              boxShadow: hovered
                ? `0 12px 32px rgba(0,0,0,0.4), 0 0 0 4px ${accent(18)}`
                : isBest ? '0 8px 24px rgba(0,0,0,0.32)' : undefined,
              color: '#fff',
              cursor: 'pointer',
              pointerEvents: 'auto',
              zIndex: 50000 + (hovered ? 500 : index),
              animation: `ghostIn 160ms ease ${index * 35}ms both`,
              transition: 'background 120ms ease, border-color 120ms ease, box-shadow 120ms ease',
            }}
          >
            <span style={{
              transform: `scale(${badgeScale})`,
              display: 'inline-flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 5,
              padding: '7px 12px',
              borderRadius: 8,
              background: 'rgba(0,0,0,0.66)',
              fontFamily: 'var(--font-sans)',
              whiteSpace: 'nowrap',
            }}>
              <strong style={{ fontSize: 16 }}>{index + 1}</strong>
              <span style={{ fontSize: 11 }}>
                {pending.existing.length > 0
                  ? isBest ? 'New · Recommended' : 'New panel'
                  : isBest ? 'Best' : 'New panel'}
              </span>
            </span>
          </button>
        )
      })}

      {[...byNode.entries()].map(([nodeId, candidates]) => {
        const node = nodes[nodeId]
        if (!node) return null
        return (
          <div
            key={`existing-${nodeId}`}
            data-panel-target
            style={{
              position: 'absolute',
              left: node.origin.x,
              top: node.origin.y,
              width: node.size.width,
              height: node.size.height,
              border: `3px solid ${accent(100)}`,
              borderRadius: 9,
              background: accent(10),
              boxShadow: `0 0 0 5px ${accent(20)}, 0 12px 32px rgba(0,0,0,0.38)`,
              zIndex: 52000,
              pointerEvents: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div style={{
              transform: `scale(${badgeScale})`,
              display: 'flex',
              flexDirection: 'column',
              gap: 5,
              padding: 7,
              borderRadius: 9,
              background: 'rgba(0,0,0,0.72)',
              pointerEvents: 'auto',
              fontFamily: 'var(--font-sans)',
            }}>
              {candidates.map((candidate) => {
                const existingIndex = pending.existing.findIndex(
                  (item) => item.panelId === candidate.panelId,
                )
                return (
                  <button
                    key={candidate.panelId}
                    type="button"
                    data-panel-target
                    onClick={(event) => {
                      event.stopPropagation()
                      api.getState().selectExistingPanelTarget(candidate.panelId)
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 7,
                      maxWidth: 280,
                      padding: '5px 9px',
                      border: 'none',
                      borderRadius: 6,
                      background: accent(92),
                      color: '#fff',
                      cursor: 'pointer',
                      fontSize: 11,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <strong>{pending.candidates.length + existingIndex + 1}</strong>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      Use {candidate.title}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </>
  )
}

export default React.memo(PanelTargetLayer)
