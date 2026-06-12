// =============================================================================
// Corner placement helpers — shared by the floating minimap and the resting
// Canvas Pet avatar. Both dock into one of four canvas corners; when one is
// dragged onto the corner the other occupies, the occupant is shoved to the
// next free corner so they never stack.
// =============================================================================

import type { CanvasCorner } from '../../shared/types'

// Cyclic order used to push a displaced widget along to the next corner.
const CORNER_ORDER: CanvasCorner[] = ['bottom-right', 'bottom-left', 'top-left', 'top-right']

/** Which corner of `rect` the point falls into (rect in client coordinates). */
export function cornerFromPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): CanvasCorner {
  const right = clientX > rect.left + rect.width / 2
  const bottom = clientY > rect.top + rect.height / 2
  return `${bottom ? 'bottom' : 'top'}-${right ? 'right' : 'left'}` as CanvasCorner
}

/**
 * Corner a displaced widget should retreat to when something lands on top of it.
 * Walks the cyclic order starting after `from`, skipping `avoid` (the corner the
 * mover now holds).
 */
export function nextFreeCorner(from: CanvasCorner, avoid: CanvasCorner): CanvasCorner {
  const start = CORNER_ORDER.indexOf(from)
  for (let i = 1; i <= CORNER_ORDER.length; i++) {
    const c = CORNER_ORDER[(start + i) % CORNER_ORDER.length]
    if (c !== avoid) return c
  }
  return from
}
