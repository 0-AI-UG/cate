// =============================================================================
// Canvas store — pure helpers shared by multiple slices.
// =============================================================================

import type { CanvasNodeId, CanvasNodeState } from '../../../shared/types'

// Under e2e the windows are hidden, which throttles rAF — the rAF-driven
// entering->idle node transition can stall, leaving nodes at scale(0.85) so
// boundingBox-based drag specs grab the wrong point. Create nodes already idle
// in e2e so their geometry is final immediately (no enter animation).
export const IS_E2E = typeof window !== 'undefined' && window.electronAPI?.isE2E === true

/** View-space pixels the canvas pans per Shift+Arrow keystroke. */
export const PAN_STEP = 120

export function generateId(): string {
  return crypto.randomUUID()
}

/**
 * Find the spatially-nearest node in a direction from a reference centre.
 * Uses a directional cone: the candidate must lie in the half-plane AND the
 * move axis must dominate, so we don't jump to a node that's mostly sideways.
 * Shared by navigateDirection (focus + activate) and navigateSelect (select
 * without activating).
 */
export function findNodeInDirection(
  nodeList: CanvasNodeState[],
  refX: number,
  refY: number,
  dir: 'up' | 'down' | 'left' | 'right',
  excludeId?: CanvasNodeId,
): CanvasNodeState | null {
  let best: CanvasNodeState | null = null
  let bestScore = Infinity
  for (const n of nodeList) {
    if (excludeId && n.id === excludeId) continue
    const dx = n.origin.x + n.size.width / 2 - refX
    const dy = n.origin.y + n.size.height / 2 - refY
    const adx = Math.abs(dx)
    const ady = Math.abs(dy)

    let inCone: boolean
    let score: number
    if (dir === 'left') { inCone = dx < 0 && adx >= ady; score = adx + 2 * ady }
    else if (dir === 'right') { inCone = dx > 0 && adx >= ady; score = adx + 2 * ady }
    else if (dir === 'up') { inCone = dy < 0 && ady >= adx; score = ady + 2 * adx }
    else { inCone = dy > 0 && ady >= adx; score = ady + 2 * adx }
    if (!inCone) continue

    if (score < bestScore) {
      bestScore = score
      best = n
    }
  }
  return best
}
