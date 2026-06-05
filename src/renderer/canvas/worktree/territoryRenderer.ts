// =============================================================================
// territoryRenderer — the pure drawing routine for the worktree "terrace
// territory". Framework-free: given a 2D context, the current view, and the
// worktree groups (colour + canvas-space panel rects), it paints each
// worktree's territory as two distinct, stacked elevation shelves.
//
// Technique (all screen-space, bounded by the viewport — no SVG filter, no
// tile-memory blowup): build a signed-distance field to each worktree's
// rounded, smoothly-merged panels — plus an MST of center-to-center capsule
// "bridges" (fading out with the panel gap) so nearby same-worktree panels fuse
// into one blob — with a static domain warp for organic edges. Then fill TWO
// EXCLUSIVE terrace shelves with crisp marching-squares polygons: an inner disk
// (brighter) and an outer annulus (carved out so it isn't behind the inner one,
// dimmer), each with its own gentle inward fade. Stroke the two shelf edges as
// thin crisp contours, then punch the panels out so the territory reads as a
// halo BEHIND them. Kept separate from React so it's unit-testable.
// =============================================================================

import {
  FIELD_CELL, REACH, INTENSITY, OUTER_LEVEL, CORNER, PANEL_CORNER, SMINK,
  CONNECT_RADIUS, CONNECT_MAX_GAP, CONNECT_FALLOFF,
  INNER_RING_FRAC, OUTLINE_WIDTH, OUTLINE_ALPHA, WARP_AMP, WARP_FREQ,
} from './territoryConfig'

export interface TerritoryRect { x: number; y: number; w: number; h: number }
export interface TerritoryGroup { color: string; rects: TerritoryRect[] }
export interface TerritoryView {
  /** CSS px size of the canvas (the ctx is already DPR-transformed). */
  width: number
  height: number
  zoom: number
  offsetX: number
  offsetY: number
}

// --- value noise (static; gives the organic domain warp) -------------------
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
  let s = 0, a = 0.5, f = 1
  for (let i = 0; i < 3; i++) { s += a * vnoise(x * f, y * f); f *= 2; a *= 0.5 }
  return s
}

// Signed distance to a rounded rectangle (negative inside).
function sdRoundRect(px: number, py: number, x: number, y: number, w: number, h: number, r: number): number {
  const cx = x + w / 2, cy = y + h / 2, hx = w / 2 - r, hy = h / 2 - r
  const qx = Math.abs(px - cx) - hx, qy = Math.abs(py - cy) - hy
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0)
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r
}
// Polynomial smooth-min (iq) — merges distances without a kink.
function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b)
  const h = Math.max(k - Math.abs(a - b), 0) / k
  return Math.min(a, b) - h * h * k * 0.25
}
// Straight-line gap (canvas px) between two rectangles' borders; 0 if they
// touch/overlap. Used to fade out bridges between far-apart panels.
function rectGap(a: TerritoryRect, b: TerritoryRect): number {
  const dx = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w), 0)
  const dy = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h), 0)
  return Math.sqrt(dx * dx + dy * dy)
}
// Signed distance to a capsule (line segment a→b with radius r).
function sdSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number, r: number): number {
  const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay
  const denom = bax * bax + bay * bay
  const h = denom > 1e-6 ? Math.max(0, Math.min(1, (pax * bax + pay * bay) / denom)) : 0
  const dx = pax - bax * h, dy = pay - bay * h
  return Math.sqrt(dx * dx + dy * dy) - r
}

/** Minimum spanning tree over panel centers (Prim's) → the connection lines
 *  that join every same-worktree panel without criss-crossing. Flat [a,b,...]. */
function mstEdges(cx: Float64Array, cy: Float64Array): number[] {
  const n = cx.length
  const edges: number[] = []
  if (n < 2) return edges
  const used = new Set<number>([0])
  while (used.size < n) {
    let bi = -1, bj = -1, bd = Infinity
    for (const i of used) {
      for (let j = 0; j < n; j++) {
        if (used.has(j)) continue
        const dx = cx[i] - cx[j], dy = cy[i] - cy[j], d = dx * dx + dy * dy
        if (d < bd) { bd = d; bi = i; bj = j }
      }
    }
    if (bj < 0) break
    edges.push(bi, bj)
    used.add(bj)
  }
  return edges
}

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.trim().replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h, 16)
  if (Number.isNaN(n)) return [255, 255, 255]
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function mixWhite([r, g, b]: [number, number, number], t: number): string {
  return `rgb(${Math.round(r + (255 - r) * t)},${Math.round(g + (255 - g) * t)},${Math.round(b + (255 - b) * t)})`
}

// Fill the region where `field < thr` as crisp marching-squares polygons
// (smooth piecewise-linear band edges, NO bilinear bleed). Uses the current
// fillStyle / globalAlpha / compositeOperation.
function fillBelow(
  ctx: CanvasRenderingContext2D,
  field: Float32Array,
  cols: number,
  rows: number,
  thr: number,
): void {
  const C = FIELD_CELL
  for (let gy = 0; gy < rows - 1; gy++) {
    for (let gx = 0; gx < cols - 1; gx++) {
      const i = gy * cols + gx
      const tl = field[i], tr = field[i + 1], br = field[i + cols + 1], bl = field[i + cols]
      const n = (tl < thr ? 1 : 0) + (tr < thr ? 1 : 0) + (br < thr ? 1 : 0) + (bl < thr ? 1 : 0)
      if (n === 0) continue
      const x0 = gx * C, y0 = gy * C, x1 = x0 + C, y1 = y0 + C
      if (n === 4) { ctx.fillRect(x0, y0, C, C); continue }
      const T = (a: number, b: number) => (thr - a) / (b - a)
      const pts: number[] = []
      if (tl < thr) pts.push(x0, y0)
      if ((tl < thr) !== (tr < thr)) pts.push(x0 + C * T(tl, tr), y0)
      if (tr < thr) pts.push(x1, y0)
      if ((tr < thr) !== (br < thr)) pts.push(x1, y0 + C * T(tr, br))
      if (br < thr) pts.push(x1, y1)
      if ((br < thr) !== (bl < thr)) pts.push(x0 + C * T(bl, br), y1)
      if (bl < thr) pts.push(x0, y1)
      if ((bl < thr) !== (tl < thr)) pts.push(x0, y0 + C * T(tl, bl))
      if (pts.length < 6) continue
      ctx.beginPath()
      ctx.moveTo(pts[0], pts[1])
      for (let k = 2; k < pts.length; k += 2) ctx.lineTo(pts[k], pts[k + 1])
      ctx.closePath()
      ctx.fill()
    }
  }
}

/** One terrace shelf: a single flat crisp fill of the region `field < outer` at
 *  colour `color`, opacity `base`. The caller carves/sequences shelves so they
 *  are two distinct bands, not stacked into one fade. */
function fillShelf(
  ctx: CanvasRenderingContext2D,
  field: Float32Array,
  cols: number,
  rows: number,
  color: string,
  outer: number,
  base: number,
): void {
  ctx.fillStyle = color
  ctx.globalAlpha = base
  fillBelow(ctx, field, cols, rows, outer)
  ctx.globalAlpha = 1
}

/** Stroke the iso-distance contour `field == thr` as a crisp thin line
 *  (marching-squares isolines). One worktree colour, one terrace edge. */
function strokeContour(
  ctx: CanvasRenderingContext2D,
  field: Float32Array,
  cols: number,
  rows: number,
  thr: number,
  color: string,
  alpha: number,
  lw: number,
): void {
  const C = FIELD_CELL
  ctx.strokeStyle = color
  ctx.globalAlpha = alpha
  ctx.lineWidth = lw
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.beginPath()
  for (let gy = 0; gy < rows - 1; gy++) {
    for (let gx = 0; gx < cols - 1; gx++) {
      const i = gy * cols + gx
      const tl = field[i], tr = field[i + 1], br = field[i + cols + 1], bl = field[i + cols]
      let c = 0
      if (tl > thr) c |= 8
      if (tr > thr) c |= 4
      if (br > thr) c |= 2
      if (bl > thr) c |= 1
      if (c === 0 || c === 15) continue
      const x0 = gx * C, y0 = gy * C
      const T = (a: number, b: number) => (thr - a) / (b - a)
      const TP: [number, number] = [x0 + C * T(tl, tr), y0]
      const RP: [number, number] = [x0 + C, y0 + C * T(tr, br)]
      const BP: [number, number] = [x0 + C * T(bl, br), y0 + C]
      const LP: [number, number] = [x0, y0 + C * T(tl, bl)]
      const S = (p: [number, number], q: [number, number]) => { ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]) }
      switch (c) {
        case 1: S(LP, BP); break
        case 2: S(BP, RP); break
        case 3: S(LP, RP); break
        case 4: S(TP, RP); break
        case 5: S(LP, TP); S(BP, RP); break
        case 6: S(TP, BP); break
        case 7: S(LP, TP); break
        case 8: S(TP, LP); break
        case 9: S(TP, BP); break
        case 10: S(TP, RP); S(LP, BP); break
        case 11: S(TP, RP); break
        case 12: S(LP, RP); break
        case 13: S(BP, RP); break
        case 14: S(LP, BP); break
      }
    }
  }
  ctx.stroke()
  ctx.globalAlpha = 1
}

/**
 * Paint the worktree terraces. Clears the canvas first. Safe with empty groups.
 * `ctx` must already be DPR-transformed (draw in CSS px). Static — no animation.
 */
export function drawTerritory(
  ctx: CanvasRenderingContext2D,
  view: TerritoryView,
  groups: TerritoryGroup[],
): void {
  const { width, height, zoom, offsetX, offsetY } = view
  ctx.clearRect(0, 0, width, height)
  if (groups.length === 0 || zoom <= 0) return

  const cols = Math.ceil(width / FIELD_CELL) + 1
  const rows = Math.ceil(height / FIELD_CELL) + 1

  // Domain-warped world coords per cell, computed ONCE and shared by all colours.
  const N = cols * rows
  const nx = new Float32Array(N)
  const ny = new Float32Array(N)
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const i = gy * cols + gx
      const wx = (gx * FIELD_CELL - offsetX) / zoom
      const wy = (gy * FIELD_CELL - offsetY) / zoom
      nx[i] = wx + (fbm(wx * WARP_FREQ, wy * WARP_FREQ) - 0.5) * 2 * WARP_AMP
      ny[i] = wy + (fbm(wx * WARP_FREQ + 31.4, wy * WARP_FREQ) - 0.5) * 2 * WARP_AMP
    }
  }

  const field = new Float32Array(N)
  const innerRing = REACH * INNER_RING_FRAC

  for (const g of groups) {
    const m = g.rects.length
    if (m === 0) continue
    const cx = new Float64Array(m), cy = new Float64Array(m)
    for (let r = 0; r < m; r++) { cx[r] = g.rects[r].x + g.rects[r].w / 2; cy[r] = g.rects[r].y + g.rects[r].h / 2 }
    // MST over panel centers → connection bridges. Each bridge's capsule radius
    // fades smoothly with the panels' gap — full when close, receding all the
    // way to -REACH (core AND halo retract) as the gap nears CONNECT_MAX_GAP —
    // so a connection grows/shrinks continuously instead of snapping on/off.
    const ea: number[] = [], eb: number[] = [], er: number[] = []
    const fadeStart = CONNECT_MAX_GAP - CONNECT_FALLOFF
    const mst = mstEdges(cx, cy)
    for (let e = 0; e < mst.length; e += 2) {
      const a = mst[e], b = mst[e + 1]
      const gap = rectGap(g.rects[a], g.rects[b])
      if (gap >= CONNECT_MAX_GAP) continue
      let w = 1
      if (gap > fadeStart) { const t = 1 - (gap - fadeStart) / CONNECT_FALLOFF; w = t * t * (3 - 2 * t) }
      ea.push(a); eb.push(b); er.push(CONNECT_RADIUS * w - REACH * (1 - w))
    }

    for (let i = 0; i < N; i++) {
      const px = nx[i], py = ny[i]
      let d = 1e9
      for (let r = 0; r < m; r++) {
        const rc = g.rects[r]
        d = smin(d, sdRoundRect(px, py, rc.x, rc.y, rc.w, rc.h, CORNER), SMINK)
      }
      for (let e = 0; e < ea.length; e++) {
        d = smin(d, sdSegment(px, py, cx[ea[e]], cy[ea[e]], cx[eb[e]], cy[eb[e]], er[e]), SMINK)
      }
      field[i] = d
    }

    // Two DISTINCT shelves, each its own fill:
    // 1) outer annulus first, 2) carve the inner disk out of it (so it isn't
    //    behind the inner shelf), 3) inner disk on top — brighter.
    fillShelf(ctx, field, cols, rows, g.color, REACH, INTENSITY * OUTER_LEVEL)
    ctx.globalCompositeOperation = 'destination-out'
    ctx.globalAlpha = 1
    ctx.fillStyle = '#000'
    fillBelow(ctx, field, cols, rows, innerRing)
    ctx.globalCompositeOperation = 'source-over'
    fillShelf(ctx, field, cols, rows, g.color, innerRing, INTENSITY)

    // Crisp thin terrace edges — inner ring brighter, outer ring fades out.
    const line = mixWhite(hexToRgb(g.color), 0.35)
    strokeContour(ctx, field, cols, rows, innerRing, line, OUTLINE_ALPHA, OUTLINE_WIDTH)
    strokeContour(ctx, field, cols, rows, REACH, line, OUTLINE_ALPHA * 0.5, OUTLINE_WIDTH)
  }

  // Punch the panels out so the territory reads as a halo BEHIND opaque panels,
  // never tinting their bodies — robust to panel chrome opacity and DOM
  // stacking. Panels are clean screen-space rects (world rect × zoom + offset).
  ctx.globalCompositeOperation = 'destination-out'
  ctx.fillStyle = '#000'
  ctx.globalAlpha = 1
  const pr = PANEL_CORNER * zoom
  for (const g of groups) {
    for (const rc of g.rects) {
      ctx.beginPath()
      ctx.roundRect(rc.x * zoom + offsetX, rc.y * zoom + offsetY, rc.w * zoom, rc.h * zoom, pr)
      ctx.fill()
    }
  }
  ctx.globalCompositeOperation = 'source-over'
}
