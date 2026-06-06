// =============================================================================
// territoryRenderer — the pure drawing routine for the worktree "terrace
// territory". Framework-free: given a 2D context, the current view, and the
// worktree groups (colour + canvas-space panel rects), it paints ONE fused
// territory shared by all worktrees, coloured per-pixel by the nearest worktree.
//
// Technique (all screen-space, bounded by the viewport — no SVG filter, no
// tile-memory blowup): build a signed-distance field per worktree to its
// rounded, smoothly-merged panels — plus capsule "bridges" (fading out with the
// panel gap) so nearby same-worktree panels fuse. The worktrees INTERACT: the
// territory shape is their union (so they connect, no avoidance gap), the colour
// is a soft per-pixel blend weighted by nearness. The shape is drawn as two
// DISTINCT terrace shelves (crisp vector clips) with smooth colour, then thin
// contour outlines and a panel punch-out so it reads as a halo BEHIND the panels.
//
// Performance: the per-cell SDF/colour work is computed in ONE fused pass that
// (a) skips cells outside every panel's reach (the empty gaps between spread
// windows cost only a cheap bbox test), (b) evaluates each panel/bridge only for
// cells inside its own reach box, and (c) skips the colour blend where one
// worktree clearly dominates. The redundant pan recompute is avoided a level up
// (WorktreeTerritoryLayer caches the raster and blits it while panning).
// =============================================================================

import {
  FIELD_CELL, REACH, OUTER_REACH_SCALE, INTENSITY, OUTER_LEVEL, CORNER, PANEL_CORNER, SMINK,
  CONNECT_RADIUS, CONNECT_MAX_GAP, CONNECT_FALLOFF, COLOR_BLEND,
  INNER_RING_FRAC, OUTLINE_WIDTH, OUTLINE_ALPHA, WARP_AMP, WARP_FREQ,
} from './territoryConfig'

export interface TerritoryRect { x: number; y: number; w: number; h: number }
export interface TerritoryGroup {
  color: string
  rects: TerritoryRect[]
  /** Opacity multiplier for the focus lens (1 = full, 0.5 = dimmed non-focused
   *  worktree). Consumed by the WebGL renderer; ignored by the CPU fallback. */
  dim?: number
}
export interface TerritoryView {
  /** CSS px size of the canvas (the ctx is already DPR-transformed). */
  width: number
  height: number
  zoom: number
  offsetX: number
  offsetY: number
}

/** Inclusive screen-cell bounds. */
interface Box { gx0: number; gy0: number; gx1: number; gy1: number }

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
// Two octaves — enough wobble for organic edges, cheaper than three.
function fbm(x: number, y: number): number {
  return 0.5 * vnoise(x, y) + 0.25 * vnoise(x * 2, y * 2)
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

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.trim().replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h, 16)
  if (Number.isNaN(n)) return [255, 255, 255]
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// --- reused scratch (avoid per-frame allocation on the rebuild/drag path) ---
let _combined = new Float32Array(0)
function ensureCombined(n: number): Float32Array {
  if (_combined.length < n) _combined = new Float32Array(n)
  return _combined
}
let _oc: HTMLCanvasElement | null = null
let _octx: CanvasRenderingContext2D | null = null
function offscreen(w: number, h: number): CanvasRenderingContext2D {
  if (!_oc) { _oc = document.createElement('canvas'); _octx = _oc.getContext('2d') }
  if (_oc.width !== w || _oc.height !== h) { _oc.width = w; _oc.height = h }
  return _octx!
}

/** Fill enclosed pockets: any cell ABOVE `thr` that can't reach the box border
 *  through other above-thr cells is background trapped inside the territory.
 *  Push it just below `thr` (to `fillVal`) so the territory fills it. */
function fillEnclosed(field: Float32Array, cols: number, thr: number, fillVal: number, b: Box): void {
  const { gx0, gy0, gx1, gy1 } = b
  const bw = gx1 - gx0 + 1, bh = gy1 - gy0 + 1
  const outside = new Uint8Array(bw * bh)
  const stack: number[] = []
  const seed = (gx: number, gy: number) => {
    const li = (gy - gy0) * bw + (gx - gx0)
    if (!outside[li] && field[gy * cols + gx] >= thr) { outside[li] = 1; stack.push(li) }
  }
  for (let gx = gx0; gx <= gx1; gx++) { seed(gx, gy0); seed(gx, gy1) }
  for (let gy = gy0; gy <= gy1; gy++) { seed(gx0, gy); seed(gx1, gy) }
  while (stack.length) {
    const li = stack.pop()!
    const lx = li % bw, ly = (li - lx) / bw
    const gx = gx0 + lx, gy = gy0 + ly
    if (lx > 0) seed(gx - 1, gy)
    if (lx < bw - 1) seed(gx + 1, gy)
    if (ly > 0) seed(gx, gy - 1)
    if (ly < bh - 1) seed(gx, gy + 1)
  }
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const li = (gy - gy0) * bw + (gx - gx0)
      const i = gy * cols + gx
      if (!outside[li] && field[i] >= thr) field[i] = fillVal
    }
  }
}

/** Clip the context to the region `field < thr` (crisp marching-squares
 *  polygons) within box `b`. */
function clipBelow(ctx: CanvasRenderingContext2D, field: Float32Array, cols: number, thr: number, b: Box, C: number): void {
  ctx.beginPath()
  for (let gy = b.gy0; gy < b.gy1; gy++) {
    for (let gx = b.gx0; gx < b.gx1; gx++) {
      const i = gy * cols + gx
      const tl = field[i], tr = field[i + 1], br = field[i + cols + 1], bl = field[i + cols]
      const n = (tl < thr ? 1 : 0) + (tr < thr ? 1 : 0) + (br < thr ? 1 : 0) + (bl < thr ? 1 : 0)
      if (n === 0) continue
      const x0 = gx * C, y0 = gy * C, x1 = x0 + C, y1 = y0 + C
      if (n === 4) { ctx.rect(x0, y0, C, C); continue }
      const T = (a: number, bb: number) => (thr - a) / (bb - a)
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
      ctx.moveTo(pts[0], pts[1])
      for (let k = 2; k < pts.length; k += 2) ctx.lineTo(pts[k], pts[k + 1])
      ctx.closePath()
    }
  }
  ctx.clip()
}

/** Stroke the iso-distance contour `field == thr` as a crisp thin line within `b`. */
function strokeContour(
  ctx: CanvasRenderingContext2D,
  field: Float32Array,
  cols: number,
  thr: number,
  color: string,
  alpha: number,
  lw: number,
  b: Box,
  C: number,
): void {
  ctx.strokeStyle = color
  ctx.globalAlpha = alpha
  ctx.lineWidth = lw
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.beginPath()
  for (let gy = b.gy0; gy < b.gy1; gy++) {
    for (let gx = b.gx0; gx < b.gx1; gx++) {
      const i = gy * cols + gx
      const tl = field[i], tr = field[i + 1], br = field[i + cols + 1], bl = field[i + cols]
      let c = 0
      if (tl > thr) c |= 8
      if (tr > thr) c |= 4
      if (br > thr) c |= 2
      if (bl > thr) c |= 1
      if (c === 0 || c === 15) continue
      const x0 = gx * C, y0 = gy * C
      const T = (a: number, bb: number) => (thr - a) / (bb - a)
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

interface GroupData {
  m: number
  rects: TerritoryRect[]
  cx: Float64Array
  cy: Float64Array
  pbox: Box[]            // per-panel reach box (screen cells)
  ea: number[]; eb: number[]; er: number[]
  ebox: Box[]            // per-bridge reach box (screen cells)
}

/**
 * Paint the worktree terraces. Clears the canvas first. Safe with empty groups.
 * `ctx` must already be DPR-transformed (draw in CSS px). Static — no animation.
 */
export function drawTerritory(
  ctx: CanvasRenderingContext2D,
  view: TerritoryView,
  groups: TerritoryGroup[],
  cellScale = 1,
): void {
  const { width, height, zoom, offsetX, offsetY } = view
  ctx.clearRect(0, 0, width, height)
  if (groups.length === 0 || zoom <= 0) return
  if (typeof document === 'undefined') return

  // Field sampling step. A coarser cell (cellScale > 1) trades edge crispness for
  // ~cellScale² less work — used for the live, lower-quality rebuild during drag.
  const cell = FIELD_CELL * cellScale
  const cols = Math.ceil(width / cell) + 1
  const rows = Math.ceil(height / cell) + 1
  const N = cols * rows

  const innerRing = REACH * INNER_RING_FRAC
  const outerReach = REACH * OUTER_REACH_SCALE
  const G = groups.length
  const rgbs = groups.map((g) => hexToRgb(g.color))

  // Overall bbox: panels' world extent expanded by the reach (+ warp), clamped.
  let wx0 = Infinity, wy0 = Infinity, wx1 = -Infinity, wy1 = -Infinity
  for (const g of groups) for (const rc of g.rects) {
    if (rc.x < wx0) wx0 = rc.x
    if (rc.y < wy0) wy0 = rc.y
    if (rc.x + rc.w > wx1) wx1 = rc.x + rc.w
    if (rc.y + rc.h > wy1) wy1 = rc.y + rc.h
  }
  if (!isFinite(wx0)) return
  const reach = outerReach + WARP_AMP
  const pad = 2
  const box: Box = {
    gx0: Math.max(0, Math.floor(((wx0 - reach) * zoom + offsetX) / cell) - pad),
    gy0: Math.max(0, Math.floor(((wy0 - reach) * zoom + offsetY) / cell) - pad),
    gx1: Math.min(cols - 1, Math.ceil(((wx1 + reach) * zoom + offsetX) / cell) + pad),
    gy1: Math.min(rows - 1, Math.ceil(((wy1 + reach) * zoom + offsetY) / cell) + pad),
  }
  if (box.gx0 >= box.gx1 || box.gy0 >= box.gy1) return

  // Screen-cell box for a world rectangle, clamped to the overall bbox.
  const cellBox = (a: number, b: number, c: number, d: number): Box => ({
    gx0: Math.max(box.gx0, Math.floor((a * zoom + offsetX) / cell)),
    gy0: Math.max(box.gy0, Math.floor((b * zoom + offsetY) / cell)),
    gx1: Math.min(box.gx1, Math.ceil((c * zoom + offsetX) / cell)),
    gy1: Math.min(box.gy1, Math.ceil((d * zoom + offsetY) / cell)),
  })

  // Per-group: panel reach boxes + bridges (with their own reach boxes). A
  // primitive only affects cells within (reach + SMINK) of it.
  const Rp = outerReach + SMINK + WARP_AMP
  const gdata: GroupData[] = groups.map((g) => {
    const m = g.rects.length
    const cx = new Float64Array(m), cy = new Float64Array(m)
    const pbox: Box[] = []
    for (let r = 0; r < m; r++) {
      const rc = g.rects[r]
      cx[r] = rc.x + rc.w / 2; cy[r] = rc.y + rc.h / 2
      pbox.push(cellBox(rc.x - Rp, rc.y - Rp, rc.x + rc.w + Rp, rc.y + rc.h + Rp))
    }
    const ea: number[] = [], eb: number[] = [], er: number[] = [], ebox: Box[] = []
    const fadeStart = CONNECT_MAX_GAP - CONNECT_FALLOFF
    for (let a = 0; a < m; a++) {
      for (let b = a + 1; b < m; b++) {
        const gap = rectGap(g.rects[a], g.rects[b])
        if (gap >= CONNECT_MAX_GAP) continue
        let w = 1
        if (gap > fadeStart) { const t = 1 - (gap - fadeStart) / CONNECT_FALLOFF; w = t * t * (3 - 2 * t) }
        const rad = CONNECT_RADIUS * w - outerReach * (1 - w)
        const cullR = rad + outerReach + SMINK + WARP_AMP
        if (cullR <= 0) continue // bridge so faded it can't reach the terrace
        ea.push(a); eb.push(b); er.push(rad)
        ebox.push(cellBox(
          Math.min(cx[a], cx[b]) - cullR, Math.min(cy[a], cy[b]) - cullR,
          Math.max(cx[a], cx[b]) + cullR, Math.max(cy[a], cy[b]) + cullR,
        ))
      }
    }
    return { m, rects: g.rects, cx, cy, pbox, ea, eb, er, ebox }
  })

  const combined = ensureCombined(N)
  const outerA = INTENSITY * OUTER_LEVEL
  const innerExtra = (INTENSITY - outerA) / (1 - outerA)
  const line = 'rgb(206,217,236)'

  const multi = G > 1
  const bw = box.gx1 - box.gx0 + 1, bh = box.gy1 - box.gy0 + 1
  const octx = multi ? offscreen(bw, bh) : null
  const img = octx ? octx.createImageData(bw, bh) : null
  const data = img ? img.data : null
  const invK = 1 / COLOR_BLEND
  const cutoff = 4 * COLOR_BLEND // beyond this gap the further worktree's weight is ~0
  const dgs = new Float64Array(G)
  const inBox = (b: Box, gx: number, gy: number) => gx >= b.gx0 && gx <= b.gx1 && gy >= b.gy0 && gy <= b.gy1

  // --- Fused pass: activity cull → warp → per-group field → colour -----------
  for (let gy = box.gy0; gy <= box.gy1; gy++) {
    for (let gx = box.gx0; gx <= box.gx1; gx++) {
      const i = gy * cols + gx

      // Active = inside some primitive's reach box (cheap, no warp/sqrt).
      let active = false
      for (let gi = 0; gi < G && !active; gi++) {
        const gd = gdata[gi]
        for (let r = 0; r < gd.m; r++) if (inBox(gd.pbox[r], gx, gy)) { active = true; break }
        if (active) break
        for (let e = 0; e < gd.ea.length; e++) if (inBox(gd.ebox[e], gx, gy)) { active = true; break }
      }
      if (!active) {
        combined[i] = 1e9
        if (data) data[((gy - box.gy0) * bw + (gx - box.gx0)) * 4 + 3] = 0
        continue
      }

      const wx = (gx * cell - offsetX) / zoom
      const wy = (gy * cell - offsetY) / zoom
      const px = wx + (fbm(wx * WARP_FREQ, wy * WARP_FREQ) - 0.5) * 2 * WARP_AMP
      const py = wy + (fbm(wx * WARP_FREQ + 31.4, wy * WARP_FREQ) - 0.5) * 2 * WARP_AMP

      let mn = 1e9, mn2 = 1e9, arg = 0
      for (let gi = 0; gi < G; gi++) {
        const gd = gdata[gi]
        let dg = 1e9
        for (let r = 0; r < gd.m; r++) {
          if (!inBox(gd.pbox[r], gx, gy)) continue
          const rc = gd.rects[r]
          dg = smin(dg, sdRoundRect(px, py, rc.x, rc.y, rc.w, rc.h, CORNER), SMINK)
        }
        for (let e = 0; e < gd.ea.length; e++) {
          if (!inBox(gd.ebox[e], gx, gy)) continue
          const a = gd.ea[e], b = gd.eb[e]
          dg = smin(dg, sdSegment(px, py, gd.cx[a], gd.cy[a], gd.cx[b], gd.cy[b], gd.er[e]), SMINK)
        }
        dgs[gi] = dg
        if (dg < mn) { mn2 = mn; mn = dg; arg = gi } else if (dg < mn2) { mn2 = dg }
      }
      combined[i] = mn

      if (data) {
        const o = ((gy - box.gy0) * bw + (gx - box.gx0)) * 4
        if (mn >= outerReach) { data[o + 3] = 0; continue }
        let rr: number, gg: number, bb: number
        if (mn2 - mn > cutoff) {
          const c = rgbs[arg]; rr = c[0]; gg = c[1]; bb = c[2]
        } else {
          let ws = 0; rr = 0; gg = 0; bb = 0
          for (let gi = 0; gi < G; gi++) {
            const wgt = Math.exp(-(dgs[gi] - mn) * invK)
            ws += wgt; rr += wgt * rgbs[gi][0]; gg += wgt * rgbs[gi][1]; bb += wgt * rgbs[gi][2]
          }
          rr /= ws; gg /= ws; bb /= ws
        }
        data[o] = rr; data[o + 1] = gg; data[o + 2] = bb; data[o + 3] = 255
      }
    }
  }

  fillEnclosed(combined, cols, outerReach, (innerRing + outerReach) / 2, box)

  // --- Draw two crisp terrace shelves ----------------------------------------
  if (octx && data) {
    octx.putImageData(img!, 0, 0)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    const dxp = box.gx0 * cell - cell / 2, dyp = box.gy0 * cell - cell / 2
    const dw = bw * cell, dh = bh * cell
    const drawColor = () => ctx.drawImage(_oc!, 0, 0, bw, bh, dxp, dyp, dw, dh)
    ctx.save(); clipBelow(ctx, combined, cols, outerReach, box, cell); ctx.globalAlpha = outerA; drawColor(); ctx.restore()
    ctx.save(); clipBelow(ctx, combined, cols, innerRing, box, cell); ctx.globalAlpha = innerExtra; drawColor(); ctx.restore()
  } else {
    // Single worktree → solid colour fills (no per-pixel blend needed).
    ctx.fillStyle = groups[0].color
    ctx.save(); clipBelow(ctx, combined, cols, outerReach, box, cell); ctx.globalAlpha = outerA; ctx.fillRect(0, 0, width, height); ctx.restore()
    ctx.save(); clipBelow(ctx, combined, cols, innerRing, box, cell); ctx.globalAlpha = innerExtra; ctx.fillRect(0, 0, width, height); ctx.restore()
  }
  ctx.globalAlpha = 1

  strokeContour(ctx, combined, cols, innerRing, line, OUTLINE_ALPHA, OUTLINE_WIDTH, box, cell)
  strokeContour(ctx, combined, cols, outerReach, line, OUTLINE_ALPHA * 0.5, OUTLINE_WIDTH, box, cell)

  // Punch the panels out so the territory reads as a halo BEHIND opaque panels.
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
