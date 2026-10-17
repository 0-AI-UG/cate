export const ZOOM_MIN = 0.3
export const ZOOM_MAX = 3.0
export const ZOOM_DEFAULT = 1.0

/** View-space pixels the canvas pans per Shift+Arrow keystroke. */
export const PAN_STEP = 120

/** Node corner radius in canvas px. The 10px tab pill plus its 2px inset stays
 *  concentric with it; territory cutouts share it. */
export const NODE_CORNER_RADIUS = 12

export function clampZoom(zoom: number): number {
  return Math.min(Math.max(zoom, ZOOM_MIN), ZOOM_MAX)
}
