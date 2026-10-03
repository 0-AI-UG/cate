// territoryMath: the framework-free signed-distance-field math shared by the
// worktree territory renderers. This is the single source of truth for the value
// noise / domain warp, the SDF primitives, and the bridge-capsule fit.
//
// Consumed by:
//   - territoryRenderer.ts  (CPU fallback, screen-space pass)
//   - territoryGeometry.ts  (WebGL primitive packing + pocket-mask sampling)
//   - territoryGL.ts         GLSL port: NOT a TS import (it is shader source).
//     The GLSL `uhash/hash`, `vnoise`, `fbm`, `sdRoundRect`, `smin`, `sdSegment`
//     in territoryGL.ts MUST be kept byte-for-byte equivalent to the functions
//     here; this file is the reference if they ever drift.
//
// Everything here is a pure function of WORLD position: there is no screen/zoom
// dependency.

/** A canvas-space panel rectangle (origin + size). Owned here so the SDF helpers
 *  that consume it (rectGap, bridgeCapsule) stay framework-free; re-exported by
 *  territoryRenderer.ts for the existing import sites. */
export interface TerritoryRect { x: number; y: number; w: number; h: number }

/** Parse a hex color (`#rgb` or `#rrggbb`, with or without `#`) to a 0-255 RGB
 *  triple. Falls back to white for malformed input. Shared by both renderers. */
export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.trim().replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h, 16)
  if (Number.isNaN(n)) return [255, 255, 255]
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// --- value noise (static; gives the organic domain warp) -------------------
export function hash(x: number, y: number): number {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263
  h = (h ^ (h >> 13)) * 1274126177
  return ((h ^ (h >> 16)) >>> 0) / 4294967295
}
export function vnoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf)
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1)
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v
}
// Large flowing base + a subtle finer octave for organic, non-uniform edges (low
// weight so it adds life without the old tight wobble). Keep in sync with
// territoryGL.ts (GLSL port).
export function fbm(x: number, y: number): number {
  return vnoise(x, y) * 0.82 + vnoise(x * 2.3 + 11.7, y * 2.3 + 5.1) * 0.18
}

// Signed distance to a rounded rectangle (negative inside).
export function sdRoundRect(px: number, py: number, x: number, y: number, w: number, h: number, r: number): number {
  const cx = x + w / 2, cy = y + h / 2, hx = w / 2 - r, hy = h / 2 - r
  const qx = Math.abs(px - cx) - hx, qy = Math.abs(py - cy) - hy
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0)
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r
}
// Polynomial smooth-min (iq): merges distances without a kink.
export function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b)
  const h = Math.max(k - Math.abs(a - b), 0) / k
  return Math.min(a, b) - h * h * k * 0.25
}
// Signed distance to a capsule (line segment a→b with radius r).
export function sdSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number, r: number): number {
  const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay
  const denom = bax * bax + bay * bay
  const h = denom > 1e-6 ? Math.max(0, Math.min(1, (pax * bax + pay * bay) / denom)) : 0
  const dx = pax - bax * h, dy = pay - bay * h
  return Math.sqrt(dx * dx + dy * dy) - r
}
// Straight-line gap (canvas px) between two rectangles' borders; 0 if they
// touch/overlap. Used to fade out bridges between far-apart panels.
export function rectGap(a: TerritoryRect, b: TerritoryRect): number {
  const dx = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w), 0)
  const dy = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h), 0)
  return Math.sqrt(dx * dx + dy * dy)
}
// Fit a capsule that fuses two panels by filling only the gap + their interiors,
// never reaching the outer edges: so a connection never domes the far top/bottom.
// Endpoints sit at the panels' FACING edges; radius is capped to the perpendicular
// half-extent (flush sides) and full along-axis extent (cap can't poke out the far
// edge). Returns [ax, ay, bx, by, radius].
export function bridgeCapsule(a: TerritoryRect, b: TerritoryRect, r: number): [number, number, number, number, number] {
  const acx = a.x + a.w / 2, acy = a.y + a.h / 2
  const bcx = b.x + b.w / 2, bcy = b.y + b.h / 2
  const dx = bcx - acx, dy = bcy - acy
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (dist < 1e-6) return [acx, acy, bcx, bcy, Math.min(r, a.w / 2, a.h / 2, b.w / 2, b.h / 2)]
  const ux = dx / dist, uy = dy / dist
  // Half-extent of each box along the axis and perpendicular to it.
  const axA = Math.abs(ux) * a.w / 2 + Math.abs(uy) * a.h / 2
  const axB = Math.abs(ux) * b.w / 2 + Math.abs(uy) * b.h / 2
  const perpA = Math.abs(uy) * a.w / 2 + Math.abs(ux) * a.h / 2
  const perpB = Math.abs(uy) * b.w / 2 + Math.abs(ux) * b.h / 2
  const rr = Math.min(r, perpA, perpB, 2 * axA, 2 * axB)
  // Endpoints at the FACING edges (centers shifted toward each other by their
  // along-axis half-extent); collapse to the midpoint if the panels overlap.
  let sa = axA
  let sb = dist - axB
  if (sa > sb) { const mid = (sa + sb) / 2; sa = mid; sb = mid }
  return [acx + ux * sa, acy + uy * sa, acx + ux * sb, acy + uy * sb, rr]
}
