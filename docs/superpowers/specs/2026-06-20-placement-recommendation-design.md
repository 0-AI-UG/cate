# Placement Recommendation — Neighbor-Aware Sizing, Shared-Grid Alignment, Fixed Default Size, and a Removable Visualization

Date: 2026-06-20
Branch: `fix-position-recommendation`
Status: Approved design — ready for implementation plan

## Problem

The interactive "ghost" placement picker (`recommendPlacements` in
`src/renderer/canvas/placement.ts`) recommends where a new panel should go. The
recent grow-to-fill work made it size a new panel to fill a gap that is bracketed
by windows on **both** sides of an axis (`pinnedX` / `pinnedY`). But in the common
case where there is a neighbor on only **one** side (a window directly above with
open space below, or a window to the left with open space to the right), the
algorithm gives up on matching and falls back to the panel's **default size**, and
it positions on the generic 20px grid rather than on the lines other windows
already use. The result: new panels don't match their neighbor's width/height and
gaps drift out of alignment.

Two secondary goals ride along:

- The default panel size is currently user-configurable (`defaultPanelWidth` /
  `defaultPanelHeight`). It should be a fixed per-type constant, not changeable.
- We want an in-app, **removable** visualization to see how gap, growth, and
  matching come together while we tune the algorithm.

## Non-Goals

- No ML / RL. This is a deterministic geometry problem; a learned model would
  trade away the exact-alignment guarantee that is the entire point, and there is
  no training signal or labeled data.
- No global lattice/constraint solver. A guide-line list gets consistent
  columns/rows/gaps at a fraction of the complexity and stays pure and testable.
- No change to the packer, clearance, dedupe, ranking, or the
  empty-canvas / blank-viewport / focus-vs-cursor behavior.
- No production UI for the visualization — it is a dev-only, throwaway tool.

---

## Part 1 — Neighbor-aware sizing + shared-grid alignment

All changes are inside `src/renderer/canvas/placement.ts`. The free-rectangle
decomposition (`freeRectangles` / `splitFree` / `pruneFreeRects`), the nearest-first
packing loop, `finalize()` (clearance + dedupe + ranking), `findFreePosition`, and
`nudgeToFree` are unchanged. Only the **size** and **point** computed per free
rectangle change, plus one new pure helper.

### 1a. `deriveGuides(nodes, gap) → { xs: number[]; ys: number[] }` (new pure helper)

- From every window collect edge lines: left & right x into `xs`, top & bottom y
  into `ys`.
- Add **gap-offset lines**: for each edge, also emit `edge + gap` and `edge - gap`,
  so a new panel can land exactly one standard gap from an existing edge.
- Dedupe (within a small epsilon) and sort each list.
- O(n). No store / React dependency. Unit-tested directly.

### 1b. Balanced sizing — mirror → grow-to-fill → default (replaces the open-axis fallback at lines ~358-359)

Per free rect, sizing follows a three-way balanced rule:

- **Mirror a neighbor when it fits.** When a window (or already-placed ghost) is
  adjacent to the rect (touching any one of its four sides with a positive shared
  run) and its **FULL size — both width and height** fits the grid-aligned interior
  (within a one-grid-step `FIT_TOL`), the panel takes that neighbor's full size. When
  several windows touch the rect, the neighbor with the **longest shared run** along
  its touching edge wins (the truest alignment partner), tie-broken by proximity to
  the ranking point. This yields uniform same-size tiles.
- **Grow-to-fill a genuinely empty gap.** When a neighbor exists but its full size
  does NOT fit, the panel grows to fill the interior of the gap — but only if the gap
  is useful, i.e. at least `USEFUL_MIN_W` × `USEFUL_MIN_H`. A gap thinner than that in
  either dimension is **SKIPPED** rather than filled with a thin sliver. This means an
  empty gap whose size matches no neighbor (mismatched-size neighbors around a center
  hole) still gets a recommendation instead of being left unused. Grow-to-fill is
  additionally guarded by aspect ratio — a gap whose filled shape would deviate too
  far from the panel's natural aspect ratio (`FILL_AR_FACTOR`) is skipped rather than
  producing an awkward tall/narrow or wide/flat tile.
- **Default where there is no neighbor at all.** With nothing adjacent, the panel
  falls back to the per-type default size; a rect too small for it (beyond `FIT_TOL`)
  is skipped.

The chosen size is clamped to `[PLACEMENT_MIN, PLACEMENT_MAX]` (and the slot's
available extent) so an unusually large neighbor or gap cannot produce an enormous
panel. Already-placed ghosts count as mirror neighbors (the packer carries a growing
obstacle list seeded with the real windows and appended to as each ghost is placed),
so the window's size chains outward, tiling the recommendations into a uniform grid.

### 1c. Guide-snapped positioning (replaces the grid-only snap at lines ~362-365)

After the size is chosen, position the panel near the ranking point as today, then
snap each **edge** to the nearest guide from 1a when within a tolerance (~half a
panel gap); otherwise fall back to the 20px grid. Then re-clamp inside the free
rect so clearance is never broken. Effect: left/right edges line up into columns,
top/bottom into rows, and the gap to neighbors equals the gaps already on the
canvas.

Note: 1b already aligns one pair of edges as a side effect (matching a neighbor's
width and aligning x to it makes both edges share the neighbor's column). 1c
generalizes this to all edges via the guide list — the two are consistent, not
competing.

`finalize` (dedup + clearance + ranking) trusts these packed positions as-is — it
does NOT re-snap them to the grid. The packer already aligns each spot to a guide
or the grid and clamps it inside its gap-carrying free rect; a second grid snap in
`finalize` would nudge a guide-aligned spot (common when a window's size or edge is
off-grid) by up to half a grid step, cutting its clearance below the gap so
`finalize`'s own clearance check would then drop it. The blank-canvas (`centred`)
spots, which arrive un-aligned, are grid-snapped at their source instead.

On an empty/blank area the picker offers the same spot in a few sizes (default /
larger / compact) rather than identical tiles in different positions, since
position is irrelevant when the area is empty — so the meaningful choice becomes
size. The default-size spot is centred on the anchor and ranks best.

---

## Part 2 — Fixed (non-configurable) default panel size

Make panel size a fixed per-type constant; remove user configurability.

- **`src/shared/types.ts`** — delete `defaultPanelWidth` / `defaultPanelHeight`
  from the `AppSettings` type and from `DEFAULT_SETTINGS`.
- **`src/main/settingsFile.ts`** — delete the two validation-schema entries.
- **`src/renderer/settings/CanvasSettings.tsx`** — delete the two `NumberInput`
  setting rows.
- **`src/shared/panels.ts`** — simplify `resolvePanelSize()` to return the per-type
  default (`PANEL_DEFINITIONS[type].defaultSize`) directly; drop the
  `UNSET_PANEL_WIDTH` / `UNSET_PANEL_HEIGHT` magic values. Keep the function
  signature so call sites (`panelSlice.ts`) are untouched.

**Migration:** existing `settings.json` files may still contain the two keys.
Settings load already tolerates unknown keys, so old values go inert — no crash, no
migration code.

---

## Part 3 — Contained, removable visualization overlay

A dev overlay that draws how **gap → growth → match → alignment** come together, on
the live canvas, fully isolated so it can be deleted in one step.

### Containment / removability (the load-bearing constraint)

- All overlay UI lives in one folder: `src/renderer/canvas/placementViz/` (overlay
  component + its own styles). Nothing outside it imports from it.
- **One wiring line** mounts it in `Canvas.tsx`, behind a **dev-only keyboard
  shortcut** that toggles visibility. Gated so it is a no-op in production builds.
  No settings UI.
- **One optional parameter** on `recommendPlacements(..., trace?)`: a trace sink the
  real packing loop fills as it runs, so the overlay renders the *actual*
  computation rather than a re-implementation that could drift. When `trace` is
  omitted (production path), it is zero cost and causes zero behavior change.
- **Removal = delete the `placementViz/` folder + the one mount line in
  `Canvas.tsx` + the optional `trace` param and its type.** That is the entire
  footprint.

### Trace shape

A `PlacementTrace` object (collected only when passed) capturing, per run:

- the place area rect and the ranking point;
- each window's inflated (gap-band) rect;
- the free rectangles, in order;
- the derived guides (`xs` / `ys`);
- per packed step: the chosen free rect, `pinnedX` / `pinnedY` flags, the matched
  neighbor (if any) for each open axis with the matched dimension, the guide each
  edge snapped to, and the final size + point.

### What it draws (annotated, over the real windows)

- The place-area outline and each window's gap band.
- The free rectangles, numbered.
- Per step: pinned axes as brackets between the two bracketing windows (label
  "filled gap = N"); open axes with the matched neighbor highlighted (label
  "matched A's width = N").
- The alignment guides as dotted column/row lines, marking which guide each edge
  snapped to.
- The resulting ghost with a size/gap label, plus the ranking-point dot and the
  step ordering.

### Data source

Live canvas state (the windows currently open). No curated scenario set.

---

## Testing

Extend `src/renderer/canvas/placement.test.ts` (pure, no React):

1. Stacked window (neighbor above) → new panel matches the neighbor's **width** and
   edges are aligned.
2. Side-by-side window (neighbor left) → new panel matches the neighbor's
   **height**.
3. Three windows with an established gap → new panel **reuses the existing gap**.
4. Guide-snapping prefers a shared column over the raw 20px grid.
5. `deriveGuides` emits edge lines and `edge ± gap` lines, deduped and sorted.
6. Longest-shared-run tiebreak picks the right neighbor when several touch an edge.
7. Clamping: neighbor larger than MAX / smaller than MIN / larger than the slot all
   clamp correctly.
8. Regressions: pinned-fill, empty-canvas, blank-viewport, and focus-vs-cursor
   ranking are unchanged.

For Part 2: a test (or adjusted existing test) confirming `resolvePanelSize`
returns the per-type default regardless of any leftover settings values.

For Part 3: a unit test that, given a known layout, the populated `PlacementTrace`
contains the expected free rects, guides, and per-step pinned/matched records —
verifying the trace mirrors the real computation. The overlay rendering itself is
not unit-tested (throwaway dev tool).

## Risks / Open Considerations

- Guide-snap tolerance (~half a gap) and the longest-run tiebreak are heuristics;
  the visualization exists precisely to tune them. Values may be adjusted during
  implementation without changing the design.
- The optional `trace` param is the only intrusion into production code; it is
  documented as removable with the overlay.
