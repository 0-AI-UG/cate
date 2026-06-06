// =============================================================================
// territoryPocketMask — the one non-per-pixel stage of the territory render.
//
// `fillEnclosed` (territoryRenderer.ts:115) fills background pockets fully
// enclosed by the territory (a ring of panels traps a "lake"). That is a flood
// fill — connectivity, not a per-pixel function — so it cannot live in the
// fragment shader. But it IS a property of WORLD-space geometry alone (the
// `combined` field is world-invariant), so it only needs recomputing when panel
// geometry changes, not per pan/zoom.
//
// This builds a coarse, WORLD-anchored mask (1 = enclosed pocket) that the shader
// samples to lift those fragments to the outer-terrace level. Recompute is gated
// by the content signature (and skipped mid-drag — a few frames of stale lake on
// a soft background halo is invisible).
// =============================================================================

import { OUTER_REACH, INNER_RING, buildGroupGeom, sampleCombined, type GroupGeom } from './territoryGeometry'
import { WARP_AMP, SMINK, POCKET_CELL, POCKET_MAX_DIM } from './territoryConfig'
import type { TerritoryGroup } from './territoryRenderer'

export interface PocketMask {
  /** R8 coverage: 1 where the cell is an enclosed pocket, else 0. Row-major, w×h. */
  data: Uint8Array
  w: number
  h: number
  /** World rect the mask spans, for shader UV mapping: uv = (world - origin)/size. */
  originX: number
  originY: number
  worldW: number
  worldH: number
}

/** Compute the enclosed-pocket mask for the given worktree groups, or null when
 *  there is nothing to enclose (no rects, or a grid too small to have an
 *  interior). Pure — no GL, no per-frame state. */
export function buildPocketMask(groups: TerritoryGroup[]): PocketMask | null {
  // World bbox of all panels, expanded by the reach (matches the renderer's
  // sampled region, territoryRenderer.ts:270-285).
  let wx0 = Infinity, wy0 = Infinity, wx1 = -Infinity, wy1 = -Infinity
  for (const g of groups) for (const rc of g.rects) {
    if (rc.x < wx0) wx0 = rc.x
    if (rc.y < wy0) wy0 = rc.y
    if (rc.x + rc.w > wx1) wx1 = rc.x + rc.w
    if (rc.y + rc.h > wy1) wy1 = rc.y + rc.h
  }
  if (!isFinite(wx0)) return null

  // Pad to the territory's MAX extent beyond the panels (reach + smin bulge) PLUS
  // a full background ring, so the grid border is guaranteed to be background. A
  // complete background border is what lets the flood seed the true outside — an
  // under-padded grid leaves border cells inside the territory, sealing open
  // regions and producing FALSE enclosures (fill bleeding into open space).
  const margin = OUTER_REACH + SMINK + WARP_AMP
  const pad = margin + OUTER_REACH
  const x0 = wx0 - pad, y0 = wy0 - pad
  const worldW = wx1 + pad - x0, worldH = wy1 + pad - y0
  if (worldW <= 0 || worldH <= 0) return null

  // Step = POCKET_CELL, raised so neither dimension exceeds POCKET_MAX_DIM cells.
  const step = Math.max(POCKET_CELL, worldW / POCKET_MAX_DIM, worldH / POCKET_MAX_DIM)
  const w = Math.max(1, Math.ceil(worldW / step) + 1)
  const h = Math.max(1, Math.ceil(worldH / step) + 1)
  if (w < 3 || h < 3) return null // no interior cells → nothing can be enclosed

  const geom: GroupGeom[] = groups.map(buildGroupGeom)

  // Sample the combined field on the world grid (cell centers at x0 + gx*step).
  const field = new Float32Array(w * h)
  for (let gy = 0; gy < h; gy++) {
    const wy = y0 + gy * step
    for (let gx = 0; gx < w; gx++) {
      field[gy * w + gx] = sampleCombined(x0 + gx * step, wy, geom)
    }
  }

  const data = enclosedMask(field, w, h, OUTER_REACH)
  if (!data) return null // no pockets — let the shader skip the mask sample entirely

  return { data, w, h, originX: x0, originY: y0, worldW: (w - 1) * step, worldH: (h - 1) * step }
}

/** Pure flood-fill: mark cells with `field >= thr` ("background") that CANNOT
 *  reach the grid border through other background cells — i.e. pockets enclosed
 *  by territory. Returns 255 at enclosed cells (else 0), or null if none. This is
 *  the connectivity core of territoryRenderer's fillEnclosed, in world-grid form. */
export function enclosedMask(field: Float32Array, w: number, h: number, thr: number): Uint8Array | null {
  const outside = new Uint8Array(w * h)
  const stack: number[] = []
  const seed = (gx: number, gy: number) => {
    const li = gy * w + gx
    if (!outside[li] && field[li] >= thr) { outside[li] = 1; stack.push(li) }
  }
  for (let gx = 0; gx < w; gx++) { seed(gx, 0); seed(gx, h - 1) }
  for (let gy = 0; gy < h; gy++) { seed(0, gy); seed(w - 1, gy) }
  while (stack.length) {
    const li = stack.pop()!
    const lx = li % w, ly = (li - lx) / w
    if (lx > 0) seed(lx - 1, ly)
    if (lx < w - 1) seed(lx + 1, ly)
    if (ly > 0) seed(lx, ly - 1)
    if (ly < h - 1) seed(lx, ly + 1)
  }
  const data = new Uint8Array(w * h)
  let any = false
  for (let i = 0; i < data.length; i++) {
    if (!outside[i] && field[i] >= thr) { data[i] = 255; any = true }
  }
  return any ? data : null
}

/** Fill value the shader lifts enclosed pockets to — same as the CPU renderer
 *  (territoryRenderer.ts:406): between the inner and outer rings, so a pocket
 *  reads as flat outer-terrace (no inner shelf, no contour through its interior). */
export const POCKET_FILL = (INNER_RING + OUTER_REACH) / 2
