import type { Point } from '../../shared/types'

/**
 * Runs an inertia animation loop with exponential decay.
 * Returns a cancel function.
 */
export function inertiaLoop(
  velocity: Point,
  apply: (delta: Point) => void,
  decay: number = 0.95,
  threshold: number = 0.5,
): () => void {
  let vel = { ...velocity }
  let rafId = 0
  let lastTime = performance.now()

  const tick = () => {
    const now = performance.now()
    const dt = Math.min(now - lastTime, 32) // Cap at ~30fps minimum
    lastTime = now

    // Frame-rate independent decay
    const factor = Math.pow(decay, dt / 16.67)
    vel.x *= factor
    vel.y *= factor

    if (Math.abs(vel.x) < threshold && Math.abs(vel.y) < threshold) {
      return // animation complete
    }

    apply({ x: vel.x * (dt / 16.67), y: vel.y * (dt / 16.67) })
    rafId = requestAnimationFrame(tick)
  }

  rafId = requestAnimationFrame(tick)

  return () => {
    if (rafId) cancelAnimationFrame(rafId)
  }
}
