// Detached window bounds are shared; each client clamps them to its own
// screens before it opens the window. Pure, for the desktop shell.

import type { Rect } from '@workspace/canvas/contract'

export interface ScreenArea {
  x: number
  y: number
  width: number
  height: number
}

/** The screen holding most of `bounds` (else the first), with the window
 *  moved inside it and shrunk to fit. */
export function clampToScreens(bounds: Rect, screens: readonly ScreenArea[]): Rect {
  if (screens.length === 0) return bounds
  const overlap = (s: ScreenArea) => {
    const w = Math.min(bounds.origin.x + bounds.size.width, s.x + s.width) - Math.max(bounds.origin.x, s.x)
    const h = Math.min(bounds.origin.y + bounds.size.height, s.y + s.height) - Math.max(bounds.origin.y, s.y)
    return w > 0 && h > 0 ? w * h : 0
  }
  const screen = screens.reduce((best, s) => (overlap(s) > overlap(best) ? s : best), screens[0])
  const width = Math.min(Math.round(bounds.size.width), screen.width)
  const height = Math.min(Math.round(bounds.size.height), screen.height)
  const x = Math.min(Math.max(Math.round(bounds.origin.x), screen.x), screen.x + screen.width - width)
  const y = Math.min(Math.max(Math.round(bounds.origin.y), screen.y), screen.y + screen.height - height)
  return { origin: { x, y }, size: { width, height } }
}
