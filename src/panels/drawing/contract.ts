// The drawing panel's record: the strokes drawn in one drawing session (pen,
// highlighter, lines, arrows, shapes) are a record field, so they are
// document state next to the node rect that places the drawing. Points are in
// the drawing's own space, `0..frame`; the node shows that space stretched to
// its rect, so resizing the node scales the drawing. A stroke drawn past the
// edge grows the space (and the node) to hold it. Pure.

import type { Json, JsonObject, PanelRecord } from '@workspace/document/contract'

export const DRAWING_STROKES_FIELD = 'strokes'
/** The size of the drawing's own space (`{ width, height }`). */
export const DRAWING_FRAME_FIELD = 'frame'

export const STROKE_KINDS = ['pen', 'highlighter', 'line', 'arrow', 'rect', 'ellipse'] as const
export type StrokeKind = (typeof STROKE_KINDS)[number]

export interface Stroke {
  kind: StrokeKind
  /** Flat x, y pairs. A pen or highlighter is its path; a line or arrow its
   *  two ends; a rect or ellipse two opposite corners. */
  points: number[]
  color: string
  width: number
  dashed: boolean
  /** A rect or ellipse is filled with a tint of its colour. */
  filled: boolean
}

export interface DrawingSize { width: number; height: number }
export interface DrawingPoint { x: number; y: number }
export interface DrawingRect { origin: DrawingPoint; size: DrawingSize }

/** Room kept around the strokes, so a thick line's edge is not cut off. */
export const DRAWING_MARGIN = 8

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function readStroke(value: unknown): Stroke | null {
  if (!value || typeof value !== 'object') return null
  const s = value as Record<string, unknown>
  if (!(STROKE_KINDS as readonly unknown[]).includes(s.kind)) return null
  if (!Array.isArray(s.points) || s.points.length < 2 || s.points.length % 2 !== 0 || !s.points.every(isNum)) return null
  return {
    kind: s.kind as StrokeKind,
    points: s.points as number[],
    color: typeof s.color === 'string' ? s.color : '#FF3B30',
    width: isNum(s.width) && s.width > 0 ? s.width : 3,
    dashed: s.dashed === true,
    filled: s.filled === true,
  }
}

/** A drawing's strokes; unreadable ones are skipped. */
export function drawingStrokes(record: PanelRecord): Stroke[] {
  const raw = record.fields[DRAWING_STROKES_FIELD]
  return Array.isArray(raw) ? raw.map(readStroke).filter((s): s is Stroke => s !== null) : []
}

/** The size of a drawing's own space; null when it has none yet. */
export function drawingFrame(record: PanelRecord): DrawingSize | null {
  const raw = record.fields[DRAWING_FRAME_FIELD] as { width?: unknown; height?: unknown } | undefined
  return raw && isNum(raw.width) && isNum(raw.height) && raw.width > 0 && raw.height > 0
    ? { width: raw.width, height: raw.height }
    : null
}

const round = (n: number) => Math.round(n * 10) / 10

export function strokeToJson(stroke: Stroke): JsonObject {
  return { ...stroke, points: stroke.points.map(round) } as unknown as JsonObject
}

export function strokesToJson(strokes: readonly Stroke[]): Json {
  return strokes.map(strokeToJson)
}

/** The box a stroke covers, its line width included. */
export function strokeBounds(stroke: Stroke): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < stroke.points.length; i += 2) {
    const x = stroke.points[i], y = stroke.points[i + 1]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  // An arrow's head reaches past its tip.
  const pad = stroke.width / 2 + (stroke.kind === 'arrow' ? stroke.width * 3 : 0)
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad }
}

/** The stroke moved by `dx, dy` and scaled by `sx, sy` (width by their mean). */
export function transformStroke(stroke: Stroke, dx: number, dy: number, sx = 1, sy = 1): Stroke {
  return {
    ...stroke,
    points: stroke.points.map((v, i) => (i % 2 === 0 ? (v + dx) * sx : (v + dy) * sy)),
    width: stroke.width * (sx + sy) / 2,
  }
}

/**
 * Adds `stroke`, in canvas coordinates, to a drawing shown at `rect` with its
 * own space `frame` (null for a new drawing: `rect` is then ignored). Returns
 * the strokes and space to save and the node rect that shows them where they
 * were drawn: the space only grows, so earlier strokes stay where they are.
 */
export function addStroke(
  strokes: readonly Stroke[],
  frame: DrawingSize | null,
  rect: DrawingRect | null,
  stroke: Stroke,
): { strokes: Stroke[]; frame: DrawingSize; rect: DrawingRect } {
  // Canvas units per unit of the drawing's space.
  const scaleX = frame && rect ? rect.size.width / frame.width : 1
  const scaleY = frame && rect ? rect.size.height / frame.height : 1
  const origin = frame && rect ? rect.origin : { x: 0, y: 0 }
  const local = transformStroke(stroke, -origin.x, -origin.y, 1 / scaleX, 1 / scaleY)

  const b = strokeBounds(local)
  const minX = Math.min(frame ? 0 : Infinity, b.minX - DRAWING_MARGIN)
  const minY = Math.min(frame ? 0 : Infinity, b.minY - DRAWING_MARGIN)
  const maxX = Math.max(frame ? frame.width : -Infinity, b.maxX + DRAWING_MARGIN)
  const maxY = Math.max(frame ? frame.height : -Infinity, b.maxY + DRAWING_MARGIN)

  const shifted = [...strokes, local].map((s) => transformStroke(s, -minX, -minY))
  const nextFrame = { width: Math.ceil(maxX - minX), height: Math.ceil(maxY - minY) }
  return {
    strokes: shifted,
    frame: nextFrame,
    rect: {
      origin: { x: origin.x + minX * scaleX, y: origin.y + minY * scaleY },
      size: { width: Math.ceil(nextFrame.width * scaleX), height: Math.ceil(nextFrame.height * scaleY) },
    },
  }
}

function distanceToSegment(p: DrawingPoint, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay
  const length = dx * dx + dy * dy
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / length))
  return Math.hypot(p.x - (ax + t * dx), p.y - (ay + t * dy))
}

/** The segments a stroke is drawn with (a shape's outline). */
function strokeSegments(stroke: Stroke): number[][] {
  const pts = stroke.points
  if (stroke.kind === 'rect' || stroke.kind === 'ellipse') {
    const [x1, y1, x2, y2] = pts
    if (stroke.kind === 'rect') return [[x1, y1, x2, y1], [x2, y1, x2, y2], [x2, y2, x1, y2], [x1, y2, x1, y1]]
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2
    const steps = 32
    const ring: number[][] = []
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2, b = ((i + 1) / steps) * Math.PI * 2
      ring.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a), cx + rx * Math.cos(b), cy + ry * Math.sin(b)])
    }
    return ring
  }
  if (pts.length === 2) return [[pts[0], pts[1], pts[0], pts[1]]]
  const segments: number[][] = []
  for (let i = 0; i + 3 < pts.length; i += 2) segments.push([pts[i], pts[i + 1], pts[i + 2], pts[i + 3]])
  return segments
}

/** Whether `point` (in the stroke's space) is within `radius` of the stroke's
 *  line, or inside a filled shape. */
export function hitsStroke(stroke: Stroke, point: DrawingPoint, radius: number): boolean {
  const reach = radius + stroke.width / 2
  if (stroke.filled && (stroke.kind === 'rect' || stroke.kind === 'ellipse')) {
    const [x1, y1, x2, y2] = stroke.points
    if (point.x >= Math.min(x1, x2) && point.x <= Math.max(x1, x2) && point.y >= Math.min(y1, y2) && point.y <= Math.max(y1, y2)) {
      if (stroke.kind === 'rect') return true
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = Math.abs(x2 - x1) / 2 || 1, ry = Math.abs(y2 - y1) / 2 || 1
      if (((point.x - cx) / rx) ** 2 + ((point.y - cy) / ry) ** 2 <= 1) return true
    }
  }
  return strokeSegments(stroke).some(([ax, ay, bx, by]) => distanceToSegment(point, ax, ay, bx, by) <= reach)
}
