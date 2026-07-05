// =============================================================================
// Corner placement helpers for widgets that dock into a canvas corner (the
// floating minimap / its toolbar button).
// =============================================================================

import type { CanvasCorner } from '../../shared/types'

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
