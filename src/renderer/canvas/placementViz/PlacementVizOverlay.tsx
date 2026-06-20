// =============================================================================
// PlacementVizOverlay — dev-only visualization of the placement algorithm.
//
// Toggle with Cmd/Ctrl+Shift+G. Renders the place area, gap bands, free rects,
// alignment guides, and each chosen ghost (with a size/gap/match label) over the
// LIVE canvas, by running recommendPlacements with a trace sink.
//
// REMOVABLE FEATURE: delete this folder, the import + mount line in Canvas.tsx,
// and the optional `trace` param on recommendPlacements to fully remove it.
// =============================================================================
import React, { useEffect, useState } from 'react'
import { useCanvasStoreContext } from '../../stores/CanvasStoreContext'
import { recommendPlacements, type PlacementTrace } from '../placement'
import type { PanelType } from '../../../shared/types'

const SIM_PANEL: PanelType = 'editor'

const PlacementVizOverlay: React.FC = () => {
  const [visible, setVisible] = useState(false)
  const nodes = useCanvasStoreContext((s) => s.nodes)
  const focusedNodeId = useCanvasStoreContext((s) => s.focusedNodeId)
  const offset = useCanvasStoreContext((s) => s.viewportOffset)
  const zoom = useCanvasStoreContext((s) => s.zoomLevel)
  const containerSize = useCanvasStoreContext((s) => s.containerSize)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault()
        setVisible((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!visible) return null

  const trace: PlacementTrace = {
    area: { origin: { x: 0, y: 0 }, size: { width: 0, height: 0 } },
    rankAt: { x: 0, y: 0 },
    inflated: [],
    guides: { xs: [], ys: [] },
    steps: [],
  }
  recommendPlacements(nodes, focusedNodeId, SIM_PANEL, { offset, zoom, containerSize }, null, 6, undefined, trace)

  const a = trace.area
  return (
    <svg style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none', zIndex: 9999 }}>
      <rect x={a.origin.x} y={a.origin.y} width={a.size.width} height={a.size.height}
        fill="none" stroke="#888" strokeDasharray="8 6" vectorEffect="non-scaling-stroke" />

      {trace.inflated.map((r, i) => (
        <rect key={`band${i}`} x={r.origin.x} y={r.origin.y} width={r.size.width} height={r.size.height}
          fill="rgba(255,140,0,0.06)" stroke="rgba(255,140,0,0.5)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      ))}

      {trace.guides.xs.map((x, i) => (
        <line key={`gx${i}`} x1={x} y1={a.origin.y} x2={x} y2={a.origin.y + a.size.height}
          stroke="rgba(0,160,255,0.35)" strokeDasharray="2 6" vectorEffect="non-scaling-stroke" />
      ))}
      {trace.guides.ys.map((y, i) => (
        <line key={`gy${i}`} x1={a.origin.x} y1={y} x2={a.origin.x + a.size.width} y2={y}
          stroke="rgba(0,160,255,0.35)" strokeDasharray="2 6" vectorEffect="non-scaling-stroke" />
      ))}

      {trace.steps.map((s, i) => {
        const wLabel = s.pinnedX ? 'fill' : s.matchedWidth != null ? `match ${s.matchedWidth}` : 'default'
        const hLabel = s.pinnedY ? 'fill' : s.matchedHeight != null ? `match ${s.matchedHeight}` : 'default'
        return (
          <g key={`step${i}`}>
            <rect x={s.point.x} y={s.point.y} width={s.size.width} height={s.size.height}
              fill="rgba(0,200,120,0.12)" stroke="rgba(0,200,120,0.9)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
            <text x={s.point.x + 8} y={s.point.y + 22} fill="#0c8" fontSize={16}>
              {`#${i + 1} ${s.size.width}×${s.size.height}  W:${wLabel}  H:${hLabel}`}
            </text>
          </g>
        )
      })}

      <circle cx={trace.rankAt.x} cy={trace.rankAt.y} r={6} fill="#f33" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export default PlacementVizOverlay
