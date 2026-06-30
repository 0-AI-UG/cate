// =============================================================================
// territoryGeometry — pure, framework-free helpers shared by the WebGL renderer
// (territoryGL) and the pocket-mask builder (territoryPocketMask).
//
// The SDF/noise math is shared with the CPU fallback (territoryRenderer.ts) via
// territoryMath.ts, so both paths evaluate the identical field. The field is a
// pure function of WORLD position — there is no screen/zoom dependency here.
// =============================================================================

import {
  REACH, OUTER_REACH_SCALE, CORNER, SMINK,
  CONNECT_RADIUS, CONNECT_MAX_GAP, CONNECT_FALLOFF,
  INNER_RING_FRAC, WARP_AMP, WARP_FREQ, INTENSITY, OUTER_LEVEL,
  MAX_GROUPS, MAX_PRIMITIVES,
} from './territoryConfig'
import type { TerritoryGroup } from './territoryRenderer'
import {
  fbm, sdRoundRect, smin, sdSegment, rectGap, bridgeCapsule, hexToRgb, type TerritoryRect,
} from './territoryMath'

export { hexToRgb }

// --- derived constants (same formulas as territoryRenderer.ts) ---------------
export const OUTER_REACH = REACH * OUTER_REACH_SCALE
export const INNER_RING = REACH * INNER_RING_FRAC
export const OUTER_A = INTENSITY * OUTER_LEVEL
export const INNER_EXTRA = (INTENSITY - OUTER_A) / (1 - OUTER_A)

// Value noise, SDF primitives, rectGap, bridgeCapsule and hexToRgb live in
// territoryMath.ts (shared source of truth, also mirrored in the territoryGL.ts
// GLSL port for the math helpers).

// --- connection bridges (same fade logic as territoryRenderer.ts) ------------
/** `cullR` is the screen-cull reach (rad + OUTER_REACH + SMINK + WARP_AMP) the
 *  CPU renderer needs to size each bridge's reach box; it is always > 0 for an
 *  emitted bridge (the skip-if-<=0 cull happens in buildBridges). */
export interface Bridge { a: number; b: number; radius: number; ax: number; ay: number; bx: number; by: number; cullR: number }
/** Same-worktree panel pairs near enough to fuse, as fading capsule bridges.
 *  Endpoints are clamped so the cap never overshoots either panel. */
export function buildBridges(rects: TerritoryRect[]): Bridge[] {
  const m = rects.length
  const out: Bridge[] = []
  const fadeStart = CONNECT_MAX_GAP - CONNECT_FALLOFF
  for (let a = 0; a < m; a++) {
    for (let b = a + 1; b < m; b++) {
      const gap = rectGap(rects[a], rects[b])
      if (gap >= CONNECT_MAX_GAP) continue
      let w = 1
      if (gap > fadeStart) { const t = 1 - (gap - fadeStart) / CONNECT_FALLOFF; w = t * t * (3 - 2 * t) }
      const rad = CONNECT_RADIUS * w - OUTER_REACH * (1 - w)
      const cullR = rad + OUTER_REACH + SMINK + WARP_AMP
      if (cullR <= 0) continue
      const [ax, ay, bx, by, rr] = bridgeCapsule(rects[a], rects[b], rad)
      out.push({ a, b, radius: rr, ax, ay, bx, by, cullR })
    }
  }
  return out
}

// --- world-space combined field (for the pocket mask) -----------------------
/** Per-group min-SDF data: panel rects + bridge segments (centers + radius). */
export interface GroupGeom {
  rects: TerritoryRect[]
  cx: Float64Array
  cy: Float64Array
  bridges: Bridge[]
}
export function buildGroupGeom(group: TerritoryGroup): GroupGeom {
  const m = group.rects.length
  const cx = new Float64Array(m), cy = new Float64Array(m)
  for (let r = 0; r < m; r++) {
    cx[r] = group.rects[r].x + group.rects[r].w / 2
    cy[r] = group.rects[r].y + group.rects[r].h / 2
  }
  return { rects: group.rects, cx, cy, bridges: buildBridges(group.rects) }
}

/** `combined` (min over groups of the smin-merged panel+bridge SDF) at a single
 *  WORLD point, after the domain warp — identical to territoryRenderer's inner
 *  loop. Used only by the pocket-mask builder (off the per-frame path). */
export function sampleCombined(wx: number, wy: number, geom: GroupGeom[]): number {
  const px = wx + (fbm(wx * WARP_FREQ, wy * WARP_FREQ) - 0.5) * 2 * WARP_AMP
  const py = wy + (fbm(wx * WARP_FREQ + 31.4, wy * WARP_FREQ) - 0.5) * 2 * WARP_AMP
  let mn = 1e9
  for (let gi = 0; gi < geom.length; gi++) {
    const g = geom[gi]
    let dg = 1e9
    for (let r = 0; r < g.rects.length; r++) {
      const rc = g.rects[r]
      dg = smin(dg, sdRoundRect(px, py, rc.x, rc.y, rc.w, rc.h, CORNER), SMINK)
    }
    for (let e = 0; e < g.bridges.length; e++) {
      const br = g.bridges[e]
      dg = smin(dg, sdSegment(px, py, br.ax, br.ay, br.bx, br.by, br.radius), SMINK)
    }
    if (dg < mn) mn = dg
  }
  return mn
}

// --- packed primitive geometry for the GPU data texture ---------------------
//
// Each primitive = 2 RGBA32F texels (8 floats), all coords RELATIVE to `origin`
// (subtracted on the CPU so the shader works in small numbers near zero, dodging
// float32 cancellation when panels sit at large canvas coordinates):
//   texel0: [ax, ay, bx, by]
//     panel : rect corners (x,y)..(x+w,y+h)   bridge: endpoint a, endpoint b
//   texel1: [radius, groupIndex, typeFlag, 0]
//     panel : radius=CORNER  flag=0           bridge: radius=er  flag=1
export interface BuiltPrimitives {
  /** RGBA32F texel data, length = MAX_PRIMITIVES*2*4 (only first `count`*2 texels live). */
  data: Float32Array
  count: number
  /** Flat normalized colors [r,g,b, r,g,b, ...], one per group, length = groupCount*3. */
  colors: Float32Array
  /** Focus-lens opacity multiplier per group (1 = full, 0.5 = dimmed). */
  dims: Float32Array
  groupCount: number
  /** World origin all coords are relative to (panels' bounding-box min). */
  originX: number
  originY: number
  /** World-space AABB of the territory's potential coverage — every primitive
   *  expanded by the field reach (panels by OUTER_REACH+WARP_AMP+SMINK, bridges
   *  by their cullR). Lets the renderer scissor the draw to where the territory
   *  can actually appear instead of shading the whole screen. `Infinity` bounds
   *  mean "no geometry" (nothing to draw). */
  boundsMinX: number
  boundsMinY: number
  boundsMaxX: number
  boundsMaxY: number
}

const _primData = new Float32Array(MAX_PRIMITIVES * 8)
const _colorData = new Float32Array(MAX_GROUPS * 3)
const _dimData = new Float32Array(MAX_GROUPS)

/** Pack groups into the flat primitive buffer + color array. Reuses module-level
 *  scratch (no per-call allocation on the drag path). */
export function buildPrimitives(groups: TerritoryGroup[]): BuiltPrimitives {
  const groupCount = Math.min(groups.length, MAX_GROUPS)

  // Origin = panels' bounding-box min (matches territoryRenderer wx0/wy0).
  let ox = Infinity, oy = Infinity
  for (let gi = 0; gi < groupCount; gi++) {
    for (const rc of groups[gi].rects) {
      if (rc.x < ox) ox = rc.x
      if (rc.y < oy) oy = rc.y
    }
  }
  if (!isFinite(ox)) { ox = 0; oy = 0 }

  const data = _primData
  let count = 0
  // World-space coverage AABB, accumulated over every emitted primitive so the
  // renderer can scissor to it. A panel's territory reaches OUTER_REACH past its
  // rect, the domain warp can push the sampled point another WARP_AMP, and smin
  // fusion lifts the field by up to SMINK near a junction — pad by their sum.
  const PANEL_MARGIN = OUTER_REACH + WARP_AMP + SMINK
  let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity
  // Panels first (never dropped); bridges after (dropped first on overflow).
  for (let gi = 0; gi < groupCount; gi++) {
    const c = hexToRgb(groups[gi].color)
    _colorData[gi * 3] = c[0] / 255
    _colorData[gi * 3 + 1] = c[1] / 255
    _colorData[gi * 3 + 2] = c[2] / 255
    _dimData[gi] = groups[gi].dim ?? 1
    for (const rc of groups[gi].rects) {
      if (count >= MAX_PRIMITIVES) break
      const o = count * 8
      data[o] = rc.x - ox; data[o + 1] = rc.y - oy
      data[o + 2] = rc.x + rc.w - ox; data[o + 3] = rc.y + rc.h - oy
      data[o + 4] = CORNER; data[o + 5] = gi; data[o + 6] = 0; data[o + 7] = 0
      count++
      if (rc.x - PANEL_MARGIN < bMinX) bMinX = rc.x - PANEL_MARGIN
      if (rc.y - PANEL_MARGIN < bMinY) bMinY = rc.y - PANEL_MARGIN
      if (rc.x + rc.w + PANEL_MARGIN > bMaxX) bMaxX = rc.x + rc.w + PANEL_MARGIN
      if (rc.y + rc.h + PANEL_MARGIN > bMaxY) bMaxY = rc.y + rc.h + PANEL_MARGIN
    }
  }
  for (let gi = 0; gi < groupCount; gi++) {
    const rects = groups[gi].rects
    const bridges = buildBridges(rects)
    for (const br of bridges) {
      if (count >= MAX_PRIMITIVES) break
      const o = count * 8
      data[o] = br.ax - ox; data[o + 1] = br.ay - oy
      data[o + 2] = br.bx - ox; data[o + 3] = br.by - oy
      data[o + 4] = br.radius; data[o + 5] = gi; data[o + 6] = 1; data[o + 7] = 0
      count++
      // br.cullR already = radius + OUTER_REACH + SMINK + WARP_AMP.
      const lx = Math.min(br.ax, br.bx) - br.cullR
      const hx = Math.max(br.ax, br.bx) + br.cullR
      const ly = Math.min(br.ay, br.by) - br.cullR
      const hy = Math.max(br.ay, br.by) + br.cullR
      if (lx < bMinX) bMinX = lx
      if (ly < bMinY) bMinY = ly
      if (hx > bMaxX) bMaxX = hx
      if (hy > bMaxY) bMaxY = hy
    }
  }

  return {
    data, count, colors: _colorData, dims: _dimData, groupCount, originX: ox, originY: oy,
    boundsMinX: bMinX, boundsMinY: bMinY, boundsMaxX: bMaxX, boundsMaxY: bMaxY,
  }
}
