export type CanvasCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/** Which corner of `rect` (client coordinates) a point falls in. */
export function cornerFromPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): CanvasCorner {
  const right = clientX > rect.left + rect.width / 2
  const bottom = clientY > rect.top + rect.height / 2
  return `${bottom ? 'bottom' : 'top'}-${right ? 'right' : 'left'}`
}
