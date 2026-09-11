import type { Point, Rect } from '../../shared/types'
import type { PanelConnectionSide } from '../../shared/panelRelations'

const ENDPOINT_GAP = 7
const PORT_ENDPOINT_GAP = 12

interface Anchor extends Point {
  normal: Point
}

function center(rect: Rect): Point {
  return {
    x: rect.origin.x + rect.size.width / 2,
    y: rect.origin.y + rect.size.height / 2,
  }
}

function anchors(rect: Rect): Anchor[] {
  const middle = center(rect)
  return [
    { x: rect.origin.x, y: middle.y, normal: { x: -1, y: 0 } },
    { x: middle.x, y: rect.origin.y, normal: { x: 0, y: -1 } },
    { x: rect.origin.x + rect.size.width, y: middle.y, normal: { x: 1, y: 0 } },
    { x: middle.x, y: rect.origin.y + rect.size.height, normal: { x: 0, y: 1 } },
  ]
}

const SIDE_INDEX: Record<PanelConnectionSide, number> = { left: 0, top: 1, right: 2, bottom: 3 }
const SIDE_NORMAL: Record<PanelConnectionSide, Point> = {
  left: { x: -1, y: 0 },
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
}

export function panelConnectionAnchor(rect: Rect, side: PanelConnectionSide): Point {
  const boundary = anchors(rect)[SIDE_INDEX[side]]
  return {
    x: boundary.x + boundary.normal.x * PORT_ENDPOINT_GAP,
    y: boundary.y + boundary.normal.y * PORT_ENDPOINT_GAP,
  }
}

export function panelConnectionPathFromPoints(
  start: Point,
  end: Point,
  sourceSide: PanelConnectionSide,
  targetSide: PanelConnectionSide,
): string {
  const { c1, c2 } = panelConnectionControlPoints(start, end, sourceSide, targetSide)
  return `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`
}

function panelConnectionControlPoints(
  start: Point,
  end: Point,
  sourceSide: PanelConnectionSide,
  targetSide: PanelConnectionSide,
): { c1: Point; c2: Point } {
  const routeDistance = Math.hypot(end.x - start.x, end.y - start.y)
  const bend = Math.min(80, routeDistance * 0.25)
  const sourceNormal = SIDE_NORMAL[sourceSide]
  const targetNormal = SIDE_NORMAL[targetSide]
  const c1 = { x: start.x + sourceNormal.x * bend, y: start.y + sourceNormal.y * bend }
  const c2 = { x: end.x + targetNormal.x * bend, y: end.y + targetNormal.y * bend }
  return { c1, c2 }
}

function quinticControlPoints(
  start: Point,
  end: Point,
  sourceSide: PanelConnectionSide,
  targetSide: PanelConnectionSide,
  waypoint?: Point,
): [Point, Point, Point, Point, Point, Point] {
  const { c1, c2 } = panelConnectionControlPoints(start, end, sourceSide, targetSide)
  // Degree-elevate the original cubic so an untouched link keeps exactly the
  // same shape while gaining two interior controls for waypoint routing.
  const controls: [Point, Point, Point, Point, Point, Point] = [
    start,
    { x: start.x * 0.4 + c1.x * 0.6, y: start.y * 0.4 + c1.y * 0.6 },
    { x: start.x * 0.1 + c1.x * 0.6 + c2.x * 0.3, y: start.y * 0.1 + c1.y * 0.6 + c2.y * 0.3 },
    { x: c1.x * 0.3 + c2.x * 0.6 + end.x * 0.1, y: c1.y * 0.3 + c2.y * 0.6 + end.y * 0.1 },
    { x: c2.x * 0.6 + end.x * 0.4, y: c2.y * 0.6 + end.y * 0.4 },
    end,
  ]
  if (waypoint) {
    const midpoint = quinticPoint(controls, 0.5)
    // At t=.5 the two middle controls contribute 20/32 together.
    const dx = (waypoint.x - midpoint.x) * 8 / 5
    const dy = (waypoint.y - midpoint.y) * 8 / 5
    controls[2] = { x: controls[2].x + dx, y: controls[2].y + dy }
    controls[3] = { x: controls[3].x + dx, y: controls[3].y + dy }
  }
  return controls
}

function quinticPoint(controls: readonly Point[], t: number): Point {
  const points = controls.map((point) => ({ ...point }))
  for (let level = points.length - 1; level > 0; level -= 1) {
    for (let index = 0; index < level; index += 1) {
      points[index] = {
        x: points[index].x * (1 - t) + points[index + 1].x * t,
        y: points[index].y * (1 - t) + points[index + 1].y * t,
      }
    }
  }
  return points[0]
}

function quinticDerivative(controls: readonly Point[], t: number): Point {
  return quinticPoint(controls.slice(0, -1).map((point, index) => ({
    x: 5 * (controls[index + 1].x - point.x),
    y: 5 * (controls[index + 1].y - point.y),
  })), t)
}

function quinticPath(controls: readonly Point[]): string {
  const segments = 4
  const step = 1 / segments
  let path = `M ${controls[0].x} ${controls[0].y}`
  for (let index = 0; index < segments; index += 1) {
    const t0 = index * step
    const t1 = (index + 1) * step
    const start = quinticPoint(controls, t0)
    const end = quinticPoint(controls, t1)
    const startDerivative = quinticDerivative(controls, t0)
    const endDerivative = quinticDerivative(controls, t1)
    const scale = step / 3
    path += ` C ${start.x + startDerivative.x * scale} ${start.y + startDerivative.y * scale}, ${end.x - endDerivative.x * scale} ${end.y - endDerivative.y * scale}, ${end.x} ${end.y}`
  }
  return path
}

function resolvePanelConnection(
  source: Rect,
  target: Rect,
  sourceSide?: PanelConnectionSide,
  targetSide?: PanelConnectionSide,
): { start: Point; end: Point; sourceSide: PanelConnectionSide; targetSide: PanelConnectionSide } | null {
  const sourceCenter = center(source)
  const targetCenter = center(target)
  const dx = targetCenter.x - sourceCenter.x
  const dy = targetCenter.y - sourceCenter.y
  const distance = Math.hypot(dx, dy)
  if (distance < 1) return null

  let [startBoundary, endBoundary] = [
    sourceSide ? anchors(source)[SIDE_INDEX[sourceSide]] : anchors(source)[0],
    targetSide ? anchors(target)[SIDE_INDEX[targetSide]] : anchors(target)[0],
  ]
  let shortest = Number.POSITIVE_INFINITY
  for (const sourceAnchor of sourceSide ? [startBoundary] : anchors(source)) {
    for (const targetAnchor of targetSide ? [endBoundary] : anchors(target)) {
      const candidate = Math.hypot(targetAnchor.x - sourceAnchor.x, targetAnchor.y - sourceAnchor.y)
      if (candidate < shortest) {
        shortest = candidate
        startBoundary = sourceAnchor
        endBoundary = targetAnchor
      }
    }
  }
  const start = {
    x: startBoundary.x + startBoundary.normal.x * (sourceSide ? PORT_ENDPOINT_GAP : ENDPOINT_GAP),
    y: startBoundary.y + startBoundary.normal.y * (sourceSide ? PORT_ENDPOINT_GAP : ENDPOINT_GAP),
  }
  const end = {
    x: endBoundary.x + endBoundary.normal.x * (targetSide ? PORT_ENDPOINT_GAP : ENDPOINT_GAP),
    y: endBoundary.y + endBoundary.normal.y * (targetSide ? PORT_ENDPOINT_GAP : ENDPOINT_GAP),
  }
  const sourceResolvedSide = sourceSide ?? (Object.keys(SIDE_INDEX) as PanelConnectionSide[])
    .find((side) => anchors(source)[SIDE_INDEX[side]].x === startBoundary.x
      && anchors(source)[SIDE_INDEX[side]].y === startBoundary.y)!
  const targetResolvedSide = targetSide ?? (Object.keys(SIDE_INDEX) as PanelConnectionSide[])
    .find((side) => anchors(target)[SIDE_INDEX[side]].x === endBoundary.x
      && anchors(target)[SIDE_INDEX[side]].y === endBoundary.y)!
  return { start, end, sourceSide: sourceResolvedSide, targetSide: targetResolvedSide }
}

/** A stable canvas-space quintic path between the nearest rectangle edges. */
export function panelConnectionPath(
  source: Rect,
  target: Rect,
  sourceSide?: PanelConnectionSide,
  targetSide?: PanelConnectionSide,
  waypoint?: Point,
): string | null {
  const connection = resolvePanelConnection(source, target, sourceSide, targetSide)
  if (!connection) return null
  const controls = quinticControlPoints(
    connection.start,
    connection.end,
    connection.sourceSide,
    connection.targetSide,
    waypoint,
  )
  return quinticPath(controls)
}

/** The interior t=.5 point on the quintic, used by relationship controls. */
export function panelConnectionMidpoint(
  source: Rect,
  target: Rect,
  sourceSide?: PanelConnectionSide,
  targetSide?: PanelConnectionSide,
  waypoint?: Point,
): Point | null {
  const connection = resolvePanelConnection(source, target, sourceSide, targetSide)
  if (!connection) return null
  const controls = quinticControlPoints(
    connection.start,
    connection.end,
    connection.sourceSide,
    connection.targetSide,
    waypoint,
  )
  return quinticPoint(controls, 0.5)
}
