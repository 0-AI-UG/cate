// =============================================================================
// territoryConfig — tunables for the worktree "gradient territory".
//
// Each worktree paints a soft topographic territory behind its panels: a signed
// distance field built from a BASE SHAPE (its panels, rounded) plus CONNECTION
// BRIDGES (an MST of center-to-center capsules linking nearby same-worktree
// panels, fading out with distance), rendered as a smooth gradient that fades
// outward, with a couple of thin crisp terrace-edge outlines on top. Static (no
// per-frame animation). Pure data — adjust the whole look here. Values target
// the "Gradient Territories" reference (Concept 02).
//
// FIELD_CELL is in SCREEN px; the rest are CANVAS-space px unless noted.
// =============================================================================

/** Field sampling resolution in SCREEN px. Smaller = smoother edges, more cost. */
export const FIELD_CELL = 6
/** How far (canvas-space px) the territory reaches beyond the base shape — the
 *  base reach used for the inner terrace. The outer terrace extends further
 *  (see OUTER_REACH_SCALE). Doubles as the corner radius of the offset, so larger
 *  values balloon the short top/bottom edges into domes; kept tight so the
 *  territory hugs the panels' rectangle. */
export const REACH = 70
/** Outer terrace reach as a multiple of REACH. The outer terrace's outer radius
 *  is REACH·OUTER_REACH_SCALE, so it overhangs the inner terrace more. */
export const OUTER_REACH_SCALE = 1.14
/** Peak fill opacity of the INNER terrace shelf (right at the panels). Subtle. */
export const INTENSITY = 0.22
/** Base opacity of the OUTER shelf as a fraction of the inner shelf — the step
 *  down from the inner terrace to the outer one. Lower = more contrast. */
export const OUTER_LEVEL = 0.45
/** Corner radius the territory rounds the panel to (canvas-space px). */
export const CORNER = 18
/** Corner radius (canvas-space px) used when punching panels out of the
 *  territory so it reads as a halo behind them. Match CanvasNode's CORNER_RADIUS. */
export const PANEL_CORNER = 8
/** Smooth-merge radius (canvas-space px) — how organically shapes fuse. Smaller
 *  = tighter fusion with less of a rounded bulge ballooning out where two nearby
 *  panels meet. */
export const SMINK = 55
/** Half-width (canvas-space px) of the connection capsules that fuse same-worktree
 *  panels. The connection's total visual width is ~2·CONNECT_RADIUS + 2·OUTER_REACH,
 *  so a large radius balloons the bridge far wider than the panels. Kept well under
 *  a panel half-width so a connection reads as a slim waist between panels, not a
 *  fat blob — the terrace offset still gives it enough body to read as fused. */
export const CONNECT_RADIUS = 110
/** Max edge-to-edge gap (canvas-space px) between two same-worktree panels for
 *  them to fuse. Beyond this, no bridge — panels stay separate territory islands.
 *  The outer terrace stays connected nearly to this gap; the inner terrace lets
 *  go earlier (it fills at a smaller iso-distance), so wide gaps show an
 *  outer-only bridge. */
export const CONNECT_MAX_GAP = 520
/** Width (canvas-space px) of the fade band ending at CONNECT_MAX_GAP, so a
 *  bridge grows/shrinks with the gap instead of popping on/off. */
export const CONNECT_FALLOFF = 360

/** Colour blend distance (canvas-space px) between DIFFERENT worktrees. Each
 *  pixel of the fused territory is coloured by the nearest worktree; within this
 *  distance of the seam the two worktree colours blend smoothly (no gap, no hard
 *  edge). Smaller = sharper colour change, larger = wider, softer merge. */
export const COLOR_BLEND = 55

// --- terrace outlines -------------------------------------------------------
/** Inner terrace ring distance as a fraction of REACH. The inner ring sits at
 *  REACH·INNER_RING_FRAC and the outer ring at REACH, so the outer terrace band
 *  is (1 − f)/f as wide as the inner one. f = 1/3 → outer band is 2× the inner. */
export const INNER_RING_FRAC = 1 / 3
/** Terrace outline thickness (CSS px) — crisp and thin. */
export const OUTLINE_WIDTH = 1
/** Inner terrace outline opacity; the outer ring fades to half this. */
export const OUTLINE_ALPHA = 0.4

// --- domain warp (organic, smooth, static) ----------------------------------
/** Domain-warp amplitude (canvas-space px) — how far the flowing curves push the
 *  territory edge in/out. Enough to break a lone panel's halo out of a perfectly
 *  round blob into an organic sweep, without high-frequency wobble. */
export const WARP_AMP = 22
/** Domain-warp frequency — lower = larger, gentler, more flowing undulations.
 *  Wavelength ≈ 1/FREQ canvas px, so this spans roughly a panel-width per wave. */
export const WARP_FREQ = 0.0022

// --- WebGL renderer limits (territoryGL) ------------------------------------
/** Max worktree groups the shader blends per pixel (uniform color array size). */
export const MAX_GROUPS = 8
/** Max primitives (panels + capsule bridges) the geometry data texture holds.
 *  Beyond this, the farthest bridges are dropped (panels are never dropped). */
export const MAX_PRIMITIVES = 1024
/** Pocket-mask sampling step (canvas-space px). Coarser than FIELD_CELL — the
 *  enclosed-pocket topology it captures is large-scale, so this only needs to be
 *  fine enough to resolve which gaps are sealed. The grid is also capped to
 *  POCKET_MAX_DIM cells per side, raising the effective step for spread layouts. */
export const POCKET_CELL = 8
/** Hard cap on pocket-mask grid dimension (cells per side) to bound CPU cost and
 *  texture size when worktrees are spread far apart. */
export const POCKET_MAX_DIM = 512
