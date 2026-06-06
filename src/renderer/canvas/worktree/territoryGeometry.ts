// =============================================================================
// territoryGeometry — pure, framework-free helpers shared by the WebGL renderer
// (territoryGL) and the pocket-mask builder (territoryPocketMask).
//
// These mirror the math in territoryRenderer.ts (the CPU fallback) EXACTLY. They
// are duplicated rather than imported so the proven CPU path stays untouched and
// can serve as the golden A/B reference. The field is a pure function of WORLD
// position — there is no screen/zoom dependency here.
// =============================================================================

import {
  REACH, OUTER_REACH_SCALE, CORNER, SMINK,
  CONNECT_RADIUS, CONNECT_MAX_GAP, CONNECT_FALLOFF,
  INNER_RING_FRAC, WARP_AMP, WARP_FREQ, INTENSITY, OUTER_LEVEL,
  MAX_GROUPS, MAX_PRIMITIVES,
} from './territoryConfig'
import type { TerritoryGroup, TerritoryRect } from './territoryRenderer'

// --- derived constants (same formulas as territoryRenderer.ts) ---------------
export const OUTER_REACH = REACH * OUTER_REACH_SCALE
export const INNER_RING = REACH * INNER_RING_FRAC
export const OUTER_A = INTENSITY * OUTER_LEVEL
export const INNER_EXTRA = (INTENSITY - OUTER_A) / (1 - OUTER_A)

// --- value noise (static; the organic domain warp) --------------------------
function hash(x: number, y: number): number {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263
  h = (h ^ (h >> 13)) * 1274126177
  return ((h ^ (h >> 16)) >>> 0) / 4294967295
}
function vnoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf)
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1)
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v
}
function fbm(x: number, y: number): number {
  return 0.5 * vnoise(x, y) + 0.25 * vnoise(x * 2, y * 2)
}

// --- signed distance primitives ---------------------------------------------
function sdRoundRect(px: number, py: number, x: number, y: number, w: number, h: number, r: number): number {
  const cx = x + w / 2, cy = y + h / 2, hx = w / 2 - r, hy = h / 2 - r
  const qx = Math.abs(px - cx) - hx, qy = Math.abs(py - cy) - hy
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0)
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r
}
function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b)
  const h = Math.max(k - Math.abs(a - b), 0) / k
  return Math.min(a, b) - h * h * k * 0.25
}
function sdSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number, r: number): number {
  const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay
  const denom = bax * bax + bay * bay
  const h = denom > 1e-6 ? Math.max(0, Math.min(1, (pax * bax + pay * bay) / denom)) : 0
  const dx = pax - bax * h, dy = pay - bay * h
  return Math.sqrt(dx * dx + dy * dy) - r
}
function rectGap(a: TerritoryRect, b: TerritoryRect): number {
  const dx = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w), 0)
  const dy = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h), 0)
  return Math.sqrt(dx * dx + dy * dy)
}

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.trim().replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h, 16)
  if (Number.isNaN(n)) return [255, 255, 255]
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// --- connection bridges (same fade logic as territoryRenderer.ts:309-325) ----
export interface Bridge { a: number; b: number; radius: number }
/** Same-worktree panel pairs near enough to fuse, as fading capsule bridges.
 *  Endpoints are panel centers (resolved by the caller from `rects`). */
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
      out.push({ a, b, radius: rad })
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
      dg = smin(dg, sdSegment(px, py, g.cx[br.a], g.cy[br.a], g.cx[br.b], g.cy[br.b], br.radius), SMINK)
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
    }
  }
  for (let gi = 0; gi < groupCount; gi++) {
    const rects = groups[gi].rects
    const bridges = buildBridges(rects)
    for (const br of bridges) {
      if (count >= MAX_PRIMITIVES) break
      const ax = rects[br.a].x + rects[br.a].w / 2, ay = rects[br.a].y + rects[br.a].h / 2
      const bx = rects[br.b].x + rects[br.b].w / 2, by = rects[br.b].y + rects[br.b].h / 2
      const o = count * 8
      data[o] = ax - ox; data[o + 1] = ay - oy
      data[o + 2] = bx - ox; data[o + 3] = by - oy
      data[o + 4] = br.radius; data[o + 5] = gi; data[o + 6] = 1; data[o + 7] = 0
      count++
    }
  }

  return { data, count, colors: _colorData, dims: _dimData, groupCount, originX: ox, originY: oy }
}
