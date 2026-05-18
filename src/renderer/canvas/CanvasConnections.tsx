// =============================================================================
// CanvasConnections — renders Maestri-style dotted-bezier wires between two
// canvas nodes. Lives inside the world transform so it pans/zooms with the
// rest of the canvas content.
//
// Geometry: for each connection we pick the edge midpoints of the two node
// rects that face each other, then draw a cubic bezier with control points
// pulled along the connecting axis. Click on a wire to highlight; click the
// midpoint "×" badge to remove it.
// =============================================================================

import React, { useMemo, useState, useEffect } from 'react'
import { useCanvasStoreContext } from '../stores/CanvasStoreContext'
import { livePositions, useLivePositionsVersion } from './livePositions'

type Side = 'left' | 'right' | 'top' | 'bottom'

interface NodeBox {
  id: string
  x: number; y: number; w: number; h: number
}

function rectMidpointOfSide(b: NodeBox, side: Side): { x: number; y: number } {
  switch (side) {
    case 'left':   return { x: b.x,         y: b.y + b.h / 2 }
    case 'right':  return { x: b.x + b.w,   y: b.y + b.h / 2 }
    case 'top':    return { x: b.x + b.w/2, y: b.y }
    case 'bottom': return { x: b.x + b.w/2, y: b.y + b.h }
  }
}

/** Pick the side of `a` that faces `b` (and vice versa). */
function pickSides(a: NodeBox, b: NodeBox): [Side, Side] {
  const ac = { x: a.x + a.w/2, y: a.y + a.h/2 }
  const bc = { x: b.x + b.w/2, y: b.y + b.h/2 }
  const dx = bc.x - ac.x
  const dy = bc.y - ac.y
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? ['right', 'left'] : ['left', 'right']
  } else {
    return dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom']
  }
}

/** Build the cubic-bezier "rope" path between two nodes. */
function buildPath(a: NodeBox, b: NodeBox): { d: string; mid: { x: number; y: number } } {
  const [sideA, sideB] = pickSides(a, b)
  const p1 = rectMidpointOfSide(a, sideA)
  const p2 = rectMidpointOfSide(b, sideB)
  const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y)
  const pull = Math.min(220, Math.max(60, dist * 0.4))

  const cp1 = { x: p1.x, y: p1.y }
  const cp2 = { x: p2.x, y: p2.y }
  if (sideA === 'left')   cp1.x -= pull
  if (sideA === 'right')  cp1.x += pull
  if (sideA === 'top')    cp1.y -= pull
  if (sideA === 'bottom') cp1.y += pull
  if (sideB === 'left')   cp2.x -= pull
  if (sideB === 'right')  cp2.x += pull
  if (sideB === 'top')    cp2.y -= pull
  if (sideB === 'bottom') cp2.y += pull

  const d = `M ${p1.x} ${p1.y} C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${p2.x} ${p2.y}`

  // Approximate midpoint of a cubic bezier (t=0.5) via De Casteljau.
  const lerp = (a1: number, b1: number, t: number) => a1 + (b1 - a1) * t
  const t = 0.5
  const m1 = { x: lerp(p1.x, cp1.x, t), y: lerp(p1.y, cp1.y, t) }
  const m2 = { x: lerp(cp1.x, cp2.x, t), y: lerp(cp1.y, cp2.y, t) }
  const m3 = { x: lerp(cp2.x, p2.x, t), y: lerp(cp2.y, p2.y, t) }
  const n1 = { x: lerp(m1.x, m2.x, t), y: lerp(m1.y, m2.y, t) }
  const n2 = { x: lerp(m2.x, m3.x, t), y: lerp(m2.y, m3.y, t) }
  const mid = { x: lerp(n1.x, n2.x, t), y: lerp(n1.y, n2.y, t) }

  return { d, mid }
}

const SVG_PAD = 20000 // pixels in canvas-space; large enough for any reasonable workspace

const CanvasConnections: React.FC = () => {
  const connections = useCanvasStoreContext((s) => s.connections)
  const nodes = useCanvasStoreContext((s) => s.nodes)
  const annotations = useCanvasStoreContext((s) => s.annotations)
  const inFlight = useCanvasStoreContext((s) => s.inFlightConnectionIds)
  const removeConnection = useCanvasStoreContext((s) => s.removeConnection)
  const [hoverId, setHoverId] = useState<string | null>(null)

  // Subscribe to live-drag positions so the wires follow nodes mid-drag.
  // useNodeDrag bypasses the store for performance and writes raw positions
  // here every RAF tick instead.
  const liveVersion = useLivePositionsVersion()

  const paths = useMemo(() => {
    const out: Array<{ id: string; d: string; mid: { x: number; y: number }; active: boolean }> = []
    // Endpoint can be either a canvas node or a sticky-note annotation —
    // both have .origin + .size, so we can pull the rect from whichever
    // map the id is in.
    const resolveEndpoint = (id: string): NodeBox | null => {
      const node = nodes[id]
      if (node) {
        const live = livePositions.get(id)
        return {
          id,
          x: live?.x ?? node.origin.x,
          y: live?.y ?? node.origin.y,
          w: node.size.width,
          h: node.size.height,
        }
      }
      const ann = annotations[id]
      if (ann) {
        // Annotations don't go through useNodeDrag so livePositions never has
        // them — read straight from the store.
        return { id, x: ann.origin.x, y: ann.origin.y, w: ann.size.width, h: ann.size.height }
      }
      return null
    }

    for (const c of Object.values(connections)) {
      const ba = resolveEndpoint(c.from)
      const bb = resolveEndpoint(c.to)
      if (!ba || !bb) continue
      const { d, mid } = buildPath(ba, bb)
      out.push({ id: c.id, d, mid, active: inFlight.has(c.id) })
    }
    return out
    // liveVersion tick forces re-memo when any drag tick fires.
  }, [connections, nodes, annotations, inFlight, liveVersion])

  // Subtle dash-flow animation. We tick a CSS custom property on the parent
  // <svg> with a CSS animation defined in globals.css; if that's not present
  // it's still fine — the wires render statically.
  return (
    <svg
      // viewBox makes SVG-internal user units identical to the parent's
      // canvas-space coordinates. Without this, the SVG's natural coord
      // system starts at the element's CSS top-left (which is at canvas
      // (-SVG_PAD, -SVG_PAD)), and our path "M ${p1.x} ${p1.y}" — written
      // in canvas-space — would render ~20000 px off-canvas. With this
      // viewBox, canvas-coord (px, py) maps directly to where you'd expect.
      viewBox={`${-SVG_PAD} ${-SVG_PAD} ${SVG_PAD * 2} ${SVG_PAD * 2}`}
      preserveAspectRatio="none"
      style={{
        position: 'absolute',
        left: -SVG_PAD,
        top: -SVG_PAD,
        width: SVG_PAD * 2,
        height: SVG_PAD * 2,
        pointerEvents: 'none',
        overflow: 'visible',
        // Above grid/regions/annotations but below CanvasNode (default z 1).
        // Children needing interaction (paths, X badge) opt-in via pointerEvents.
        zIndex: 0,
      }}
    >
      <defs>
        <style>{`
          .cate-conn { transition: stroke-width 120ms ease, opacity 120ms ease; }
          @keyframes cate-conn-flow { to { stroke-dashoffset: -24; } }
          .cate-conn-anim { animation: cate-conn-flow 1.4s linear infinite; }
          .cate-conn-active { animation: cate-conn-flow 0.6s linear infinite; }
        `}</style>
      </defs>
      {paths.map((p) => {
        const isHover = hoverId === p.id
        const stroke = p.active ? '#4a9eff' : (isHover ? '#7cc7ff' : 'rgba(140, 170, 220, 0.75)')
        return (
          <g key={p.id}>
            {/* Wide invisible hit-target so it's easy to click the wire. */}
            <path
              d={p.d}
              stroke="transparent"
              strokeWidth={16}
              fill="none"
              style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
              onMouseEnter={() => setHoverId(p.id)}
              onMouseLeave={() => setHoverId((cur) => (cur === p.id ? null : cur))}
              onClick={(e) => { e.stopPropagation() /* keep hover; X badge handles removal */ }}
            />
            {/* The visible dotted wire. */}
            <path
              d={p.d}
              stroke={stroke}
              strokeWidth={p.active ? 2.4 : 1.6}
              strokeDasharray="6 6"
              fill="none"
              className={`cate-conn ${p.active ? 'cate-conn-active' : 'cate-conn-anim'}`}
              style={{ pointerEvents: 'none' }}
            />
            {/* Midpoint × badge — only when hovered or active. */}
            {(isHover || p.active) && (
              <g
                transform={`translate(${p.mid.x}, ${p.mid.y})`}
                style={{ pointerEvents: 'all', cursor: 'pointer' }}
                onMouseEnter={() => setHoverId(p.id)}
                onMouseLeave={() => setHoverId((cur) => (cur === p.id ? null : cur))}
                onClick={(e) => { e.stopPropagation(); removeConnection(p.id) }}
              >
                <circle r={9} fill="#1f2329" stroke={stroke} strokeWidth={1.5} />
                <path d="M -3 -3 L 3 3 M -3 3 L 3 -3" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" />
              </g>
            )}
          </g>
        )
      })}
    </svg>
  )
}

export default React.memo(CanvasConnections)
