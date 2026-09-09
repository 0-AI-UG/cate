import type { Point, Rect } from '../../shared/types'

const ENDPOINT_GAP = 7

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

/** A stable canvas-space cubic path between the nearest rectangle edges. */
export function panelConnectionPath(source: Rect, target: Rect): string | null {
  const sourceCenter = center(source)
  const targetCenter = center(target)
  const dx = targetCenter.x - sourceCenter.x
  const dy = targetCenter.y - sourceCenter.y
  const distance = Math.hypot(dx, dy)
  if (distance < 1) return null

  let [startBoundary, endBoundary] = [anchors(source)[0], anchors(target)[0]]
  let shortest = Number.POSITIVE_INFINITY
  for (const sourceAnchor of anchors(source)) {
    for (const targetAnchor of anchors(target)) {
      const candidate = Math.hypot(targetAnchor.x - sourceAnchor.x, targetAnchor.y - sourceAnchor.y)
      if (candidate < shortest) {
        shortest = candidate
        startBoundary = sourceAnchor
        endBoundary = targetAnchor
      }
    }
  }
  const start = {
    x: startBoundary.x + startBoundary.normal.x * ENDPOINT_GAP,
    y: startBoundary.y + startBoundary.normal.y * ENDPOINT_GAP,
  }
  const end = {
    x: endBoundary.x + endBoundary.normal.x * ENDPOINT_GAP,
    y: endBoundary.y + endBoundary.normal.y * ENDPOINT_GAP,
  }
  const routeDistance = Math.hypot(end.x - start.x, end.y - start.y)
  const bend = Math.min(80, routeDistance * 0.25)
  const c1 = {
    x: start.x + startBoundary.normal.x * bend,
    y: start.y + startBoundary.normal.y * bend,
  }
  const c2 = {
    x: end.x + endBoundary.normal.x * bend,
    y: end.y + endBoundary.normal.y * bend,
  }

  return `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`
}
