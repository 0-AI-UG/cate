// One stroke as SVG, in the stroke's own coordinates: the drawing view shows
// it in the drawing's space, the draw surface in canvas space while it is
// being drawn.

import type { Stroke } from '@panels/drawing/contract'

/** A highlighter's ink lets what is under it show through. */
const HIGHLIGHTER_OPACITY = 0.35
const FILL_OPACITY = 0.22

/** A smooth path through the points (quadratic curves through midpoints). */
function freehandPath(points: number[]): string {
  if (points.length <= 2) return `M ${points[0]} ${points[1]} L ${points[0]} ${points[1]}`
  let d = `M ${points[0]} ${points[1]}`
  for (let i = 2; i + 2 < points.length; i += 2) {
    const mx = (points[i] + points[i + 2]) / 2
    const my = (points[i + 1] + points[i + 3]) / 2
    d += ` Q ${points[i]} ${points[i + 1]} ${mx} ${my}`
  }
  const n = points.length
  return `${d} L ${points[n - 2]} ${points[n - 1]}`
}

function arrowHead(stroke: Stroke): string {
  const [x1, y1, x2, y2] = stroke.points
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const length = Math.max(10, stroke.width * 4)
  const spread = Math.PI / 7
  const ax = x2 - length * Math.cos(angle - spread), ay = y2 - length * Math.sin(angle - spread)
  const bx = x2 - length * Math.cos(angle + spread), by = y2 - length * Math.sin(angle + spread)
  return `M ${ax} ${ay} L ${x2} ${y2} L ${bx} ${by}`
}

export function StrokeShape({ stroke }: { stroke: Stroke }) {
  const common = {
    stroke: stroke.color,
    strokeWidth: stroke.width,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeDasharray: stroke.dashed ? `${stroke.width * 2.5} ${stroke.width * 2}` : undefined,
    fill: 'none',
  }
  const [x1, y1, x2 = x1, y2 = y1] = stroke.points
  switch (stroke.kind) {
    case 'pen':
      return <path d={freehandPath(stroke.points)} {...common} />
    case 'highlighter':
      return <path d={freehandPath(stroke.points)} {...common} strokeLinecap="butt" opacity={HIGHLIGHTER_OPACITY} />
    case 'line':
      return <path d={`M ${x1} ${y1} L ${x2} ${y2}`} {...common} />
    case 'arrow':
      return (
        <g>
          <path d={`M ${x1} ${y1} L ${x2} ${y2}`} {...common} />
          <path d={arrowHead(stroke)} {...common} strokeDasharray={undefined} />
        </g>
      )
    case 'rect':
      return (
        <rect
          x={Math.min(x1, x2)} y={Math.min(y1, y2)} width={Math.abs(x2 - x1)} height={Math.abs(y2 - y1)} rx={Math.min(6, stroke.width * 2)}
          {...common}
          fill={stroke.filled ? stroke.color : 'none'}
          fillOpacity={stroke.filled ? FILL_OPACITY : undefined}
        />
      )
    case 'ellipse':
      return (
        <ellipse
          cx={(x1 + x2) / 2} cy={(y1 + y2) / 2} rx={Math.abs(x2 - x1) / 2} ry={Math.abs(y2 - y1) / 2}
          {...common}
          fill={stroke.filled ? stroke.color : 'none'}
          fillOpacity={stroke.filled ? FILL_OPACITY : undefined}
        />
      )
  }
}
