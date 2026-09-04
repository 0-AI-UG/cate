import type { Point, Rect } from '../../shared/types'

const ENDPOINT_GAP = 7

function center(rect: Rect): Point {
  return {
    x: rect.origin.x + rect.size.width / 2,
    y: rect.origin.y + rect.size.height / 2,
  }
}

function boundaryPoint(rect: Rect, toward: Point): Point {
  const from = center(rect)
  const dx = toward.x - from.x
  const dy = toward.y - from.y
  const halfWidth = Math.max(1, rect.size.width / 2)
  const halfHeight = Math.max(1, rect.size.height / 2)
  const scale = 1 / Math.max(Math.abs(dx) / halfWidth, Math.abs(dy) / halfHeight)
  return { x: from.x + dx * scale, y: from.y + dy * scale }
}

/** A stable canvas-space cubic path between the nearest rectangle edges. */
export function panelConnectionPath(source: Rect, target: Rect): string | null {
  const sourceCenter = center(source)
  const targetCenter = center(target)
  const dx = targetCenter.x - sourceCenter.x
  const dy = targetCenter.y - sourceCenter.y
  const distance = Math.hypot(dx, dy)
  if (distance < 1) return null

  const unit = { x: dx / distance, y: dy / distance }
  const startBoundary = boundaryPoint(source, targetCenter)
  const endBoundary = boundaryPoint(target, sourceCenter)
  const start = {
    x: startBoundary.x + unit.x * ENDPOINT_GAP,
    y: startBoundary.y + unit.y * ENDPOINT_GAP,
  }
  const end = {
    x: endBoundary.x - unit.x * ENDPOINT_GAP,
    y: endBoundary.y - unit.y * ENDPOINT_GAP,
  }
  const bend = Math.min(180, Math.max(36, distance * 0.32))
  const horizontal = Math.abs(dx) >= Math.abs(dy)
  const c1 = horizontal
    ? { x: start.x + Math.sign(dx) * bend, y: start.y }
    : { x: start.x, y: start.y + Math.sign(dy) * bend }
  const c2 = horizontal
    ? { x: end.x - Math.sign(dx) * bend, y: end.y }
    : { x: end.x, y: end.y - Math.sign(dy) * bend }

  return `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`
}
