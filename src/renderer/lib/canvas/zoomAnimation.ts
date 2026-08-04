const FRAME_MS_60HZ = 1000 / 60
const ZOOM_EASE_PER_60HZ_FRAME = 0.15

/** Time-correct equivalent of applying a 0.15 lerp once per 60 Hz frame. */
export function zoomEaseForElapsed(elapsedMs: number): number {
  return 1 - Math.pow(
    1 - ZOOM_EASE_PER_60HZ_FRAME,
    Math.max(0, elapsedMs) / FRAME_MS_60HZ,
  )
}
