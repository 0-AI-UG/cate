// =============================================================================
// goo — tuning constants for the worktree "sludge" (metaball) layer.
//
// The sludge is a soft, blurred colored field painted behind the panels of a
// worktree. Each panel contributes one inflated blob; an SVG goo filter
// (blur → alpha threshold → soften) makes same-worktree blobs MERGE fluidly
// when near, STRETCH when dragged apart, and SPLIT when far — with zero
// connection geometry. A spring loop eases each blob's rect toward its panel so
// the field feels alive and bounces while dragging/resizing.
// =============================================================================

/** Shared SVG filter id (one def, referenced by every color group). */
export const GOO_FILTER_ID = 'cate-worktree-goo'

/** How far each blob extends beyond its panel, in canvas px. Bigger than the
 *  panel (per design) and wide enough that neighbouring same-worktree panels
 *  overlap and merge through the goo threshold. */
export const BLOB_MARGIN = 70

/** Corner radius of each blob rect (canvas px) — soft, lozenge-ish. */
export const BLOB_RADIUS = 48

/** Field opacity by state. The goo threshold yields a near-solid shape, so
 *  these stay low to read as an ambient wash rather than a flat fill. */
export const OPACITY_BASE = 0.16
/** Boosted when this worktree is hovered or is the focus-lens target. */
export const OPACITY_ACTIVE = 0.3
/** Other worktrees while the focus lens is locked on one — pushed back. */
export const OPACITY_DIMMED = 0.05

/** Spring integration (semi-implicit). Slightly under-damped for a little
 *  bounce as the field chases a dragged panel. */
export const SPRING_STIFFNESS = 0.2
export const SPRING_DAMPING = 0.68
/** Below this per-component velocity AND offset (px) the spring is "settled"
 *  and the rAF loop parks until the next store change. */
export const SPRING_EPSILON = 0.15

/** Animated geometry for one blob, in canvas-space. */
export interface BlobSpring {
  x: number
  y: number
  w: number
  h: number
  vx: number
  vy: number
  vw: number
  vh: number
}

/** Advance one spring component toward target; returns [next, velocity]. */
function step(pos: number, vel: number, target: number): [number, number] {
  let v = vel + (target - pos) * SPRING_STIFFNESS
  v *= SPRING_DAMPING
  return [pos + v, v]
}

/**
 * Advance a blob's spring toward target geometry. Mutates `s` in place and
 * returns true while still moving (so the caller keeps the rAF loop alive).
 */
export function advanceBlob(
  s: BlobSpring,
  tx: number,
  ty: number,
  tw: number,
  th: number,
): boolean {
  ;[s.x, s.vx] = step(s.x, s.vx, tx)
  ;[s.y, s.vy] = step(s.y, s.vy, ty)
  ;[s.w, s.vw] = step(s.w, s.vw, tw)
  ;[s.h, s.vh] = step(s.h, s.vh, th)

  const moving =
    Math.abs(s.vx) > SPRING_EPSILON ||
    Math.abs(s.vy) > SPRING_EPSILON ||
    Math.abs(s.vw) > SPRING_EPSILON ||
    Math.abs(s.vh) > SPRING_EPSILON ||
    Math.abs(s.x - tx) > SPRING_EPSILON ||
    Math.abs(s.y - ty) > SPRING_EPSILON ||
    Math.abs(s.w - tw) > SPRING_EPSILON ||
    Math.abs(s.h - th) > SPRING_EPSILON

  if (!moving) {
    // Snap to rest so attributes settle on exact values.
    s.x = tx; s.y = ty; s.w = tw; s.h = th
    s.vx = s.vy = s.vw = s.vh = 0
  }
  return moving
}
