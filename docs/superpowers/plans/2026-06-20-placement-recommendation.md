# Placement Recommendation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the panel placement recommender match a one-sided neighbor's size and align to the columns/rows existing windows already use, make the default panel size a fixed per-type constant, and add a removable in-app visualization of the algorithm.

**Architecture:** All placement math stays in the pure module `src/renderer/canvas/placement.ts` (nodes in, candidates out, no React/store deps). New pure helpers (`deriveGuides`, `matchedWidth`, `matchedHeight`, `snapAxis`, extracted `pinnedX`/`pinnedY`) are wired into the existing nearest-first packing loop; the loop also fills an optional `trace` sink with its intermediate geometry. A dev-only overlay in an isolated `placementViz/` folder reads that trace and draws it on the live canvas. The default-size setting is removed so size comes only from `PANEL_DEFINITIONS`.

**Tech Stack:** TypeScript, React 18, Vitest, zustand, electron-vite.

## Global Constraints

- Placement gap (clearance between windows): `PLACEMENT_GAP = 40`. Copy verbatim.
- Canvas grid: `CANVAS_GRID_SIZE = 20` (imported from `./layoutEngine`).
- Size bounds: `PLACEMENT_MIN_W = 280`, `PLACEMENT_MIN_H = 180`, `PLACEMENT_MAX_W = 1400`, `PLACEMENT_MAX_H = 900`.
- Guide snap tolerance: `SNAP_TOL = PLACEMENT_GAP / 2` (= 20).
- Adjacency epsilon: `EPS = 1`.
- Editor panel default size is `{ width: 600, height: 500 }` (from `PANEL_DEFINITIONS.editor.defaultSize` in `src/shared/panels.ts`); terminal is `{ width: 640, height: 400 }`. Tests rely on these exact values.
- `placement.ts` must remain free of React/store/IPC imports — pure functions only.
- Dev-only code is gated with `import.meta.env.DEV` (use the project's typed access pattern shown in Task 7).
- **Git/commit rule:** never add "Co-Authored-By: Claude" or any AI attribution to commit messages.

---

## File Structure

- `src/renderer/canvas/placement.ts` — MODIFY. Add pure helpers + `PlacementTrace` types + optional `trace` param; rewrite the packing loop's sizing/positioning.
- `src/renderer/canvas/placement.test.ts` — MODIFY. Add unit tests for the new helpers and integration tests for `recommendPlacements`.
- `src/shared/panels.ts` — MODIFY. Simplify `resolvePanelSize` to per-type default; remove `UNSET_*`.
- `src/shared/panels.test.ts` — CREATE (or add to existing). Test `resolvePanelSize`.
- `src/shared/types.ts` — MODIFY. Remove `defaultPanelWidth`/`defaultPanelHeight` from `AppSettings` and `DEFAULT_SETTINGS`.
- `src/main/settingsFile.ts` — MODIFY. Remove the two validation-schema entries.
- `src/renderer/settings/CanvasSettings.tsx` — MODIFY. Remove the two `NumberInput` rows.
- `src/renderer/canvas/placementViz/PlacementVizOverlay.tsx` — CREATE. The removable overlay.
- `src/renderer/canvas/Canvas.tsx` — MODIFY. One gated mount line + import.

---

## Task 1: `deriveGuides` pure helper

**Files:**
- Modify: `src/renderer/canvas/placement.ts`
- Test: `src/renderer/canvas/placement.test.ts`

**Interfaces:**
- Consumes: existing `CanvasNodeId`, `CanvasNodeState` types (already imported).
- Produces: `export function deriveGuides(nodes: Record<CanvasNodeId, CanvasNodeState>, gap: number): { xs: number[]; ys: number[] }` — sorted, deduped alignment lines: each window's left/right x and top/bottom y, plus each edge ± `gap`.

- [ ] **Step 1: Write the failing test**

Add to `src/renderer/canvas/placement.test.ts`:

```ts
import { deriveGuides } from './placement'
import type { CanvasNodeId, CanvasNodeState } from '../../shared/types'

let __seq = 0
const node = (x: number, y: number, w: number, h: number): CanvasNodeState =>
  ({
    id: `n${__seq++}`,
    panelType: 'editor',
    origin: { x, y },
    size: { width: w, height: h },
    creationIndex: __seq,
  } as unknown as CanvasNodeState)
const nodesOf = (...ns: CanvasNodeState[]): Record<CanvasNodeId, CanvasNodeState> =>
  Object.fromEntries(ns.map((n) => [n.id, n])) as Record<CanvasNodeId, CanvasNodeState>

describe('deriveGuides', () => {
  it('emits edge lines and edge±gap lines, deduped and sorted', () => {
    const g = deriveGuides(nodesOf(node(100, 200, 600, 400)), 40)
    // left=100, right=700; ±40 → 60,100,140 and 660,700,740
    expect(g.xs).toEqual([60, 100, 140, 660, 700, 740])
    // top=200, bottom=600; ±40 → 160,200,240 and 560,600,640
    expect(g.ys).toEqual([160, 200, 240, 560, 600, 640])
  })

  it('dedupes shared edges across windows', () => {
    // two windows sharing left edge x=100
    const g = deriveGuides(nodesOf(node(100, 0, 200, 100), node(100, 500, 200, 100)), 40)
    expect(g.xs.filter((v) => v === 100)).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/canvas/placement.test.ts -t deriveGuides`
Expected: FAIL — `deriveGuides is not a function` / not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/renderer/canvas/placement.ts`, after the existing constants block (after `PLACEMENT_MAX_H`), add the module-level `EPS` if not already present, then the helper:

```ts
const EPS = 1
const SNAP_TOL = PLACEMENT_GAP / 2

/** Sorted, deduped alignment lines implied by the existing windows: each edge plus
 *  edge ± gap, so a new panel can land on a shared column/row or exactly one gap away. */
export function deriveGuides(
  nodes: Record<CanvasNodeId, CanvasNodeState>,
  gap: number,
): { xs: number[]; ys: number[] } {
  const xs = new Set<number>()
  const ys = new Set<number>()
  for (const n of Object.values(nodes)) {
    const l = n.origin.x, r = n.origin.x + n.size.width
    const t = n.origin.y, b = n.origin.y + n.size.height
    for (const x of [l, r]) { xs.add(x); xs.add(x + gap); xs.add(x - gap) }
    for (const y of [t, b]) { ys.add(y); ys.add(y + gap); ys.add(y - gap) }
  }
  return {
    xs: [...xs].sort((a, b) => a - b),
    ys: [...ys].sort((a, b) => a - b),
  }
}
```

(If a local `const EPS = 1` already exists inside `recommendPlacements`, delete that local one — the module-level constant replaces it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/canvas/placement.test.ts -t deriveGuides`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/canvas/placement.ts src/renderer/canvas/placement.test.ts
git commit -m "feat(placement): derive alignment guide lines from existing windows"
```

---

## Task 2: Extract `pinnedX`/`pinnedY` to module level + add `matchedWidth`/`matchedHeight`

**Files:**
- Modify: `src/renderer/canvas/placement.ts`
- Test: `src/renderer/canvas/placement.test.ts`

**Interfaces:**
- Consumes: module-level `EPS` (Task 1), existing `Rect`, `Point`, `inflateRect`.
- Produces:
  - `export function pinnedX(f: Rect, inflated: Rect[]): boolean`
  - `export function pinnedY(f: Rect, inflated: Rect[]): boolean`
  - `export function matchedWidth(f: Rect, inflated: Rect[], gap: number, rankAt: Point): number | null` — the original width of the window adjacent above/below `f` with the longest shared horizontal run (tie-break: center nearest `rankAt.x`); `null` if none.
  - `export function matchedHeight(f: Rect, inflated: Rect[], gap: number, rankAt: Point): number | null` — symmetric, for a left/right neighbor.

Note: `inflated` rects are windows grown by `gap`; the original window dimension is `inflatedSize - 2 * gap`.

- [ ] **Step 1: Write the failing test**

Add to `src/renderer/canvas/placement.test.ts` (reuses `node`/`nodesOf` helpers from Task 1; if running this task in isolation, ensure those helpers exist in the file):

```ts
import { pinnedX, pinnedY, matchedWidth, matchedHeight } from './placement'

// A window inflated by gap=40. Window A: origin (1000,1000) size 600x400.
const inflate = (x: number, y: number, w: number, h: number, gap = 40) => ({
  origin: { x: x - gap, y: y - gap },
  size: { width: w + gap * 2, height: h + gap * 2 },
})

describe('matchedWidth / matchedHeight', () => {
  it('matches the width of a window directly above the free rect', () => {
    // A at (1000,1000,600,400) inflated → bottom edge at 1440.
    const A = inflate(1000, 1000, 600, 400)
    // free rect spanning below A
    const f = { origin: { x: 0, y: 1440 }, size: { width: 4000, height: 2000 } }
    expect(matchedWidth(f, [A], 40, { x: 1300, y: 1600 })).toBe(600)
  })

  it('matches the height of a window directly left of the free rect', () => {
    const A = inflate(1000, 1000, 600, 400) // right edge at 1640
    const f = { origin: { x: 1640, y: 0 }, size: { width: 2000, height: 4000 } }
    expect(matchedHeight(f, [A], 40, { x: 1900, y: 1200 })).toBe(400)
  })

  it('returns null when no neighbor touches the rect', () => {
    const A = inflate(1000, 1000, 600, 400)
    const f = { origin: { x: 3000, y: 3000 }, size: { width: 500, height: 500 } }
    expect(matchedWidth(f, [A], 40, { x: 3250, y: 3250 })).toBeNull()
  })

  it('pinnedX true only when bracketed on both sides', () => {
    const A = inflate(1000, 1000, 600, 400) // right 1640
    const B = inflate(2000, 1000, 600, 400) // left 1960
    const f = { origin: { x: 1640, y: 1000 }, size: { width: 320, height: 400 } }
    expect(pinnedX(f, [A, B])).toBe(true)
    expect(pinnedX(f, [A])).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/canvas/placement.test.ts -t "matchedWidth"`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/renderer/canvas/placement.ts`, add these module-level functions (near `deriveGuides`). If `pinnedX`/`pinnedY` currently exist as closures inside `recommendPlacements`, delete those closures — these module-level versions (taking `inflated` as a param) replace them:

```ts
/** True when a window's edge sits against BOTH the left and right sides of `f`
 *  (an interior horizontal gap), sharing a vertical run along each side. */
export function pinnedX(f: Rect, inflated: Rect[]): boolean {
  const fL = f.origin.x, fR = fL + f.size.width, fT = f.origin.y, fB = fT + f.size.height
  let left = false, right = false
  for (const o of inflated) {
    if (Math.min(o.origin.y + o.size.height, fB) - Math.max(o.origin.y, fT) <= EPS) continue
    if (Math.abs(o.origin.x + o.size.width - fL) <= EPS) left = true
    if (Math.abs(o.origin.x - fR) <= EPS) right = true
  }
  return left && right
}

/** True when a window's edge sits against BOTH the top and bottom of `f`. */
export function pinnedY(f: Rect, inflated: Rect[]): boolean {
  const fL = f.origin.x, fR = fL + f.size.width, fT = f.origin.y, fB = fT + f.size.height
  let top = false, bottom = false
  for (const o of inflated) {
    if (Math.min(o.origin.x + o.size.width, fR) - Math.max(o.origin.x, fL) <= EPS) continue
    if (Math.abs(o.origin.y + o.size.height - fT) <= EPS) top = true
    if (Math.abs(o.origin.y - fB) <= EPS) bottom = true
  }
  return top && bottom
}

/** Width of the window adjacent above/below `f` with the longest shared horizontal
 *  run (tie-break: center nearest rankAt.x). Returns the ORIGINAL width
 *  (inflated minus the gap on both sides), or null when nothing is adjacent. */
export function matchedWidth(f: Rect, inflated: Rect[], gap: number, rankAt: Point): number | null {
  const fL = f.origin.x, fR = fL + f.size.width, fT = f.origin.y, fB = fT + f.size.height
  let bestRun = 0, bestDist = Infinity, bestW: number | null = null
  for (const o of inflated) {
    const oL = o.origin.x, oR = oL + o.size.width, oT = o.origin.y, oB = oT + o.size.height
    const adjacent = Math.abs(oB - fT) <= EPS || Math.abs(oT - fB) <= EPS
    if (!adjacent) continue
    const run = Math.min(oR, fR) - Math.max(oL, fL)
    if (run <= EPS) continue
    const dist = Math.abs((oL + oR) / 2 - rankAt.x)
    if (run > bestRun + EPS || (Math.abs(run - bestRun) <= EPS && dist < bestDist)) {
      bestRun = run; bestDist = dist; bestW = oR - oL - 2 * gap
    }
  }
  return bestW
}

/** Height of the window adjacent left/right of `f` with the longest shared vertical
 *  run (tie-break: center nearest rankAt.y). Returns the ORIGINAL height, or null. */
export function matchedHeight(f: Rect, inflated: Rect[], gap: number, rankAt: Point): number | null {
  const fL = f.origin.x, fR = fL + f.size.width, fT = f.origin.y, fB = fT + f.size.height
  let bestRun = 0, bestDist = Infinity, bestH: number | null = null
  for (const o of inflated) {
    const oL = o.origin.x, oR = oL + o.size.width, oT = o.origin.y, oB = oT + o.size.height
    const adjacent = Math.abs(oR - fL) <= EPS || Math.abs(oL - fR) <= EPS
    if (!adjacent) continue
    const run = Math.min(oB, fB) - Math.max(oT, fT)
    if (run <= EPS) continue
    const dist = Math.abs((oT + oB) / 2 - rankAt.y)
    if (run > bestRun + EPS || (Math.abs(run - bestRun) <= EPS && dist < bestDist)) {
      bestRun = run; bestDist = dist; bestH = oB - oT - 2 * gap
    }
  }
  return bestH
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/canvas/placement.test.ts -t "matchedWidth"`
Expected: PASS.

Then run the whole placement file to confirm extracting the closures didn't break `recommendPlacements` (it still references the old closures until Task 5 — see note): `npx vitest run src/renderer/canvas/placement.test.ts`
Expected: the existing `recommendPlacements` tests may FAIL TO COMPILE if you removed the in-function `pinnedX`/`pinnedY` closures that the current loop still calls. That is expected and fixed in Task 5. If you prefer green-between-tasks, keep the closures for now and delete them in Task 5; the module-level functions can coexist. **Recommended:** keep the loop compiling by leaving the closures until Task 5, OR do Task 5 immediately after this one.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/canvas/placement.ts src/renderer/canvas/placement.test.ts
git commit -m "feat(placement): add neighbor-match and module-level pinned helpers"
```

---

## Task 3: `snapAxis` helper (guide-vs-grid snapping)

**Files:**
- Modify: `src/renderer/canvas/placement.ts`
- Test: `src/renderer/canvas/placement.test.ts`

**Interfaces:**
- Produces: `export function snapAxis(lo: number, size: number, guides: number[], tol: number, grid: number): number` — returns the snapped low edge: snap `lo` or `lo+size` to the nearest guide within `tol`, else snap `lo` to the grid.

- [ ] **Step 1: Write the failing test**

```ts
import { snapAxis } from './placement'

describe('snapAxis', () => {
  it('snaps the low edge to a guide within tolerance', () => {
    expect(snapAxis(1012, 600, [1000], 20, 20)).toBe(1000) // 12px off → guide
  })
  it('snaps via the high edge when that is the closer guide', () => {
    // lo=1012, size=600 → hi=1612; guide 1600 is 12px from hi → lo becomes 1000
    expect(snapAxis(1012, 600, [1600], 20, 20)).toBe(1000)
  })
  it('falls back to the grid when no guide is within tolerance', () => {
    expect(snapAxis(1012, 600, [1100], 20, 20)).toBe(1020) // nearest 20px grid
    expect(snapAxis(1012, 600, [], 20, 20)).toBe(1020)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/canvas/placement.test.ts -t snapAxis`
Expected: FAIL — not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
/** Snap the low edge of a fixed-size span to the nearest alignment guide (via either
 *  edge) when within `tol`; otherwise snap the low edge to the grid. */
export function snapAxis(lo: number, size: number, guides: number[], tol: number, grid: number): number {
  let best = Math.round(lo / grid) * grid
  let bestErr = tol
  const hi = lo + size
  for (const g of guides) {
    const eLo = Math.abs(g - lo)
    if (eLo < bestErr) { bestErr = eLo; best = g }
    const eHi = Math.abs(g - hi)
    if (eHi < bestErr) { bestErr = eHi; best = g - size }
  }
  return best
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/canvas/placement.test.ts -t snapAxis`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/canvas/placement.ts src/renderer/canvas/placement.test.ts
git commit -m "feat(placement): add edge-to-guide snapping helper"
```

---

## Task 4: `PlacementTrace` types + wire helpers into the packing loop

**Files:**
- Modify: `src/renderer/canvas/placement.ts`
- Test: `src/renderer/canvas/placement.test.ts`

**Interfaces:**
- Consumes: `deriveGuides`, `pinnedX`, `pinnedY`, `matchedWidth`, `matchedHeight`, `snapAxis` (Tasks 1-3), constants `SNAP_TOL`, `PLACEMENT_GAP`.
- Produces:
  - `export interface PlacementTraceStep { free: Rect[]; chosen: Rect; pinnedX: boolean; pinnedY: boolean; matchedWidth: number | null; matchedHeight: number | null; size: Size; point: Point }`
  - `export interface PlacementTrace { area: Rect; rankAt: Point; inflated: Rect[]; guides: { xs: number[]; ys: number[] }; steps: PlacementTraceStep[] }`
  - New last param on `recommendPlacements(..., sizeOverride?: Size, trace?: PlacementTrace)` — filled only when provided; no behavior change otherwise.

- [ ] **Step 1: Write the failing tests**

Add to `src/renderer/canvas/placement.test.ts`. These use `node`/`nodesOf` from Task 1 and a large viewport so all nodes are on-screen:

```ts
import { recommendPlacements, type PlacementTrace } from './placement'

const VP = { offset: { x: 0, y: 0 }, zoom: 1, containerSize: { width: 4000, height: 4000 } }

describe('recommendPlacements — neighbor-aware sizing', () => {
  it('matches the width of a window directly above (stacked)', () => {
    const ns = nodesOf(node(1000, 1000, 600, 400))
    const out = recommendPlacements(ns, null, 'editor', VP, { x: 1300, y: 1600 })
    expect(out[0].size.width).toBe(600)        // matched A's width
    expect(out[0].point.x).toBe(1000)          // aligned to A's left edge
    expect(out[0].point.y).toBe(1440)          // 40px gap below A (1400 + 40)
  })

  it('matches the height of a window to the left (side-by-side)', () => {
    const ns = nodesOf(node(1000, 1000, 600, 400))
    const out = recommendPlacements(ns, null, 'editor', VP, { x: 1900, y: 1200 })
    expect(out[0].size.height).toBe(400)       // matched A's height
    expect(out[0].point.y).toBe(1000)          // aligned to A's top edge
  })

  it('still fills a gap bracketed on both sides (pinned regression)', () => {
    const ns = nodesOf(node(1000, 1000, 600, 400), node(2000, 1000, 600, 400))
    const out = recommendPlacements(ns, null, 'editor', VP, { x: 1800, y: 1200 })
    const filled = out.find((c) => c.size.width === 320)
    expect(filled).toBeTruthy()                // fills the 320px interior gap
  })

  it('uses default size on an empty canvas (regression)', () => {
    const out = recommendPlacements({}, null, 'editor', VP, { x: 500, y: 500 })
    expect(out.length).toBeGreaterThanOrEqual(1)
    expect(out[0].size).toEqual({ width: 600, height: 500 })
  })

  it('fills a trace when one is provided', () => {
    const ns = nodesOf(node(1000, 1000, 600, 400))
    const trace: PlacementTrace = {
      area: { origin: { x: 0, y: 0 }, size: { width: 0, height: 0 } },
      rankAt: { x: 0, y: 0 }, inflated: [], guides: { xs: [], ys: [] }, steps: [],
    }
    recommendPlacements(ns, null, 'editor', VP, { x: 1300, y: 1600 }, 6, undefined, trace)
    expect(trace.steps.length).toBeGreaterThan(0)
    expect(trace.guides.xs).toContain(1000)
    const s = trace.steps[0]
    expect(s.matchedWidth).toBe(600)
    expect(s.pinnedX).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/canvas/placement.test.ts -t "neighbor-aware sizing"`
Expected: FAIL — `trace` param / new behavior not present (and/or compile error if Task 2 closures were removed).

- [ ] **Step 3: Implement — add types, param, and rewrite the loop**

In `src/renderer/canvas/placement.ts`:

(a) Add the trace types near the top exports (after `PlacementCandidate`):

```ts
export interface PlacementTraceStep {
  free: Rect[]
  chosen: Rect
  pinnedX: boolean
  pinnedY: boolean
  matchedWidth: number | null
  matchedHeight: number | null
  size: Size
  point: Point
}

export interface PlacementTrace {
  area: Rect
  rankAt: Point
  inflated: Rect[]
  guides: { xs: number[]; ys: number[] }
  steps: PlacementTraceStep[]
}
```

(b) Change the signature:

```ts
export function recommendPlacements(
  nodes: Record<CanvasNodeId, CanvasNodeState>,
  focusedNodeId: CanvasNodeId | null,
  panelType: PanelType,
  viewport: { offset: Point; zoom: number; containerSize: Size },
  anchor: Point | null,
  max = 6,
  sizeOverride?: Size,
  trace?: PlacementTrace,
): PlacementCandidate[] {
```

(c) After `const inflated = nodeRects.map((r) => inflateRect(r, gap))` and `let free = freeRectangles(area, inflated)`, delete the in-function `EPS`, `pinnedX`, `pinnedY` closures (now module-level), and add the guides + trace header:

```ts
  const guides = deriveGuides(nodes, gap)
  if (trace) {
    trace.area = area
    trace.rankAt = rankAt
    trace.inflated = inflated
    trace.guides = guides
  }
```

(d) Replace the entire packing `for` loop (the `for (let n = 0; n < max && free.length > 0; n++) { ... }` block) with:

```ts
  const raw: Raw[] = []
  for (let n = 0; n < max && free.length > 0; n++) {
    const freeSnapshot = free.slice()
    let best:
      | { point: Point; size: Size; score: number; meta: PlacementTraceStep }
      | null = null
    for (const f of free) {
      const ix0 = Math.ceil(f.origin.x / grid) * grid
      const ix1 = Math.floor((f.origin.x + f.size.width) / grid) * grid
      const iy0 = Math.ceil(f.origin.y / grid) * grid
      const iy1 = Math.floor((f.origin.y + f.size.height) / grid) * grid
      const availW = ix1 - ix0, availH = iy1 - iy0
      if (availW < PLACEMENT_MIN_W || availH < PLACEMENT_MIN_H) continue

      const pX = pinnedX(f, inflated)
      const pY = pinnedY(f, inflated)
      const mwRaw = pX ? null : matchedWidth(f, inflated, gap, rankAt)
      const mhRaw = pY ? null : matchedHeight(f, inflated, gap, rankAt)
      const mW = pX ? availW : (mwRaw ?? std.width)
      const mH = pY ? availH : (mhRaw ?? std.height)
      const w = clamp(mW, PLACEMENT_MIN_W, Math.min(PLACEMENT_MAX_W, availW))
      const h = clamp(mH, PLACEMENT_MIN_H, Math.min(PLACEMENT_MAX_H, availH))

      const rawX = rankAt.x - w / 2
      const rawY = rankAt.y - h / 2
      const point = {
        x: clamp(snapAxis(rawX, w, guides.xs, SNAP_TOL, grid), ix0, ix1 - w),
        y: clamp(snapAxis(rawY, h, guides.ys, SNAP_TOL, grid), iy0, iy1 - h),
      }
      const score = Math.hypot(point.x + w / 2 - rankAt.x, point.y + h / 2 - rankAt.y)
      if (!best || score < best.score) {
        best = {
          point,
          size: { width: w, height: h },
          score,
          meta: {
            free: freeSnapshot,
            chosen: f,
            pinnedX: pX,
            pinnedY: pY,
            matchedWidth: mwRaw,
            matchedHeight: mhRaw,
            size: { width: w, height: h },
            point,
          },
        }
      }
    }
    if (!best) break
    raw.push({ point: best.point, size: best.size })
    if (trace) trace.steps.push(best.meta)
    const placed = inflateRect({ origin: best.point, size: best.size }, gap)
    free = pruneFreeRects(free.flatMap((f) => splitFree(f, placed)))
  }

  return finalize(raw, rankAt)
```

(Keep the existing `clamp` definition; it is defined just above the loop in the current code.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/canvas/placement.test.ts`
Expected: PASS — new neighbor-aware tests and all pre-existing `placement` tests green.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/canvas/placement.ts src/renderer/canvas/placement.test.ts
git commit -m "feat(placement): neighbor-matched sizing, guide alignment, optional trace"
```

---

## Task 5: Make default panel size fixed (remove the setting)

**Files:**
- Modify: `src/shared/panels.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/main/settingsFile.ts`
- Modify: `src/renderer/settings/CanvasSettings.tsx`
- Test: `src/shared/panels.test.ts` (create if absent)

**Interfaces:**
- Produces: `resolvePanelSize(type: PanelType): Size` always returns `PANEL_DEFINITIONS[type].defaultSize`, ignoring any settings.

- [ ] **Step 1: Write the failing test**

Create `src/shared/panels.test.ts` (or append if it exists):

```ts
import { describe, it, expect } from 'vitest'
import { resolvePanelSize } from './panels'

describe('resolvePanelSize', () => {
  it('returns the fixed per-type default', () => {
    expect(resolvePanelSize('terminal')).toEqual({ width: 640, height: 400 })
    expect(resolvePanelSize('editor')).toEqual({ width: 600, height: 500 })
  })

  it('ignores any leftover settings values', () => {
    expect(resolvePanelSize('terminal', { defaultPanelWidth: 999, defaultPanelHeight: 999 } as never))
      .toEqual({ width: 640, height: 400 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/panels.test.ts`
Expected: FAIL — current `resolvePanelSize` applies the override (returns 999×999 for the second case).

- [ ] **Step 3: Implement the changes**

In `src/shared/panels.ts`: delete `UNSET_PANEL_WIDTH` / `UNSET_PANEL_HEIGHT` and replace the body of `resolvePanelSize` with:

```ts
/** The fixed default size for a panel type. Panel size is no longer user-configurable. */
export function resolvePanelSize(type: PanelType, _settings?: unknown): Size {
  return PANEL_DEFINITIONS[type].defaultSize
}
```

In `src/shared/types.ts`: remove the two lines from the `AppSettings` interface:

```ts
  defaultPanelWidth: number
  defaultPanelHeight: number
```

…and the two lines from `DEFAULT_SETTINGS`:

```ts
  defaultPanelWidth: 600,
  defaultPanelHeight: 400,
```

In `src/main/settingsFile.ts`: remove the two validation-schema entries:

```ts
  defaultPanelWidth: 'number',
  defaultPanelHeight: 'number',
```

In `src/renderer/settings/CanvasSettings.tsx`: delete the two `SettingRow` blocks:

```tsx
  <SettingRow label="Default panel width">
    <NumberInput value={store.defaultPanelWidth} onChange={(v) => store.setSetting('defaultPanelWidth', v)} min={300} max={1200} step={50} />
  </SettingRow>
  <SettingRow label="Default panel height">
    <NumberInput value={store.defaultPanelHeight} onChange={(v) => store.setSetting('defaultPanelHeight', v)} min={200} max={900} step={50} />
  </SettingRow>
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/shared/panels.test.ts`
Expected: PASS.
Run: `npx tsc --noEmit`
Expected: no errors (confirms no remaining references to `defaultPanelWidth`/`defaultPanelHeight`). If `tsc` flags a reference, remove it at the flagged location.

- [ ] **Step 5: Commit**

```bash
git add src/shared/panels.ts src/shared/panels.test.ts src/shared/types.ts src/main/settingsFile.ts src/renderer/settings/CanvasSettings.tsx
git commit -m "feat(panels): make default panel size a fixed per-type constant"
```

---

## Task 6: Removable visualization overlay + dev shortcut

**Files:**
- Create: `src/renderer/canvas/placementViz/PlacementVizOverlay.tsx`
- Modify: `src/renderer/canvas/Canvas.tsx`

**Interfaces:**
- Consumes: `recommendPlacements`, `PlacementTrace` (Task 4); `useCanvasStoreContext`; store fields `nodes`, `focusedNodeId`, `viewportOffset`, `zoomLevel`, `containerSize`.
- Produces: a default-exported `PlacementVizOverlay` React component, mounted (dev-only) inside the canvas world layer.

This task has no unit test — it is a throwaway dev tool whose data path (`PlacementTrace`) is already tested in Task 4. Verification is manual.

- [ ] **Step 1: Create the overlay component**

Create `src/renderer/canvas/placementViz/PlacementVizOverlay.tsx`:

```tsx
// =============================================================================
// PlacementVizOverlay — dev-only visualization of the placement algorithm.
//
// Toggle with Cmd/Ctrl+Shift+G. Renders the place area, gap bands, free rects,
// alignment guides, and each chosen ghost (with a size/gap/match label) over the
// LIVE canvas, by running recommendPlacements with a trace sink.
//
// REMOVABLE FEATURE: delete this folder, the import + mount line in Canvas.tsx,
// and the optional `trace` param on recommendPlacements to fully remove it.
// =============================================================================
import React, { useEffect, useState } from 'react'
import { useCanvasStoreContext } from '../../stores/CanvasStoreContext'
import { recommendPlacements, type PlacementTrace } from '../placement'
import type { PanelType } from '../../../shared/types'

const SIM_PANEL: PanelType = 'editor'

const PlacementVizOverlay: React.FC = () => {
  const [visible, setVisible] = useState(false)
  const nodes = useCanvasStoreContext((s) => s.nodes)
  const focusedNodeId = useCanvasStoreContext((s) => s.focusedNodeId)
  const offset = useCanvasStoreContext((s) => s.viewportOffset)
  const zoom = useCanvasStoreContext((s) => s.zoomLevel)
  const containerSize = useCanvasStoreContext((s) => s.containerSize)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault()
        setVisible((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!visible) return null

  const trace: PlacementTrace = {
    area: { origin: { x: 0, y: 0 }, size: { width: 0, height: 0 } },
    rankAt: { x: 0, y: 0 },
    inflated: [],
    guides: { xs: [], ys: [] },
    steps: [],
  }
  recommendPlacements(nodes, focusedNodeId, SIM_PANEL, { offset, zoom, containerSize }, null, 6, undefined, trace)

  const a = trace.area
  return (
    <svg style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none', zIndex: 9999 }}>
      <rect x={a.origin.x} y={a.origin.y} width={a.size.width} height={a.size.height}
        fill="none" stroke="#888" strokeDasharray="8 6" vectorEffect="non-scaling-stroke" />

      {trace.inflated.map((r, i) => (
        <rect key={`band${i}`} x={r.origin.x} y={r.origin.y} width={r.size.width} height={r.size.height}
          fill="rgba(255,140,0,0.06)" stroke="rgba(255,140,0,0.5)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      ))}

      {trace.guides.xs.map((x, i) => (
        <line key={`gx${i}`} x1={x} y1={a.origin.y} x2={x} y2={a.origin.y + a.size.height}
          stroke="rgba(0,160,255,0.35)" strokeDasharray="2 6" vectorEffect="non-scaling-stroke" />
      ))}
      {trace.guides.ys.map((y, i) => (
        <line key={`gy${i}`} x1={a.origin.x} y1={y} x2={a.origin.x + a.size.width} y2={y}
          stroke="rgba(0,160,255,0.35)" strokeDasharray="2 6" vectorEffect="non-scaling-stroke" />
      ))}

      {trace.steps.map((s, i) => {
        const wLabel = s.pinnedX ? 'fill' : s.matchedWidth != null ? `match ${s.matchedWidth}` : 'default'
        const hLabel = s.pinnedY ? 'fill' : s.matchedHeight != null ? `match ${s.matchedHeight}` : 'default'
        return (
          <g key={`step${i}`}>
            <rect x={s.point.x} y={s.point.y} width={s.size.width} height={s.size.height}
              fill="rgba(0,200,120,0.12)" stroke="rgba(0,200,120,0.9)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
            <text x={s.point.x + 8} y={s.point.y + 22} fill="#0c8" fontSize={16}>
              {`#${i + 1} ${s.size.width}×${s.size.height}  W:${wLabel}  H:${hLabel}`}
            </text>
          </g>
        )
      })}

      <circle cx={trace.rankAt.x} cy={trace.rankAt.y} r={6} fill="#f33" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export default PlacementVizOverlay
```

- [ ] **Step 2: Mount it (dev-only) in Canvas.tsx**

In `src/renderer/canvas/Canvas.tsx`, add the import near the other canvas-layer imports:

```tsx
import PlacementVizOverlay from './placementViz/PlacementVizOverlay'
```

Inside the world `<div ref={worldRef}>` block, immediately after `<GhostPlacementLayer />`, add the gated mount:

```tsx
        {(import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV && <PlacementVizOverlay />}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual verification**

Run: `npm run dev`. Open a project, add a couple of panels, then press **Cmd/Ctrl+Shift+G**.
Expected: an overlay appears showing the place-area outline, orange gap bands around windows, blue dotted guide lines, numbered green ghost rectangles with `W:…/H:…` labels (e.g. `W:match 600`), and a red ranking dot. Press the chord again to hide. Confirm it pans/zooms with the canvas.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/canvas/placementViz/PlacementVizOverlay.tsx src/renderer/canvas/Canvas.tsx
git commit -m "feat(placement): add removable dev visualization overlay (Cmd+Shift+G)"
```

---

## Task 7: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS. (Per CLAUDE.md, some git-touching tests can fail for environmental reasons — a dirty tree / a local `main` branch. Confirm any failures are those known-environmental ones and not in `placement`/`panels`.)

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean typecheck; build succeeds. The production build must NOT include the overlay (gated by `import.meta.env.DEV`).

- [ ] **Step 3: Commit (only if anything was adjusted)**

```bash
git add -A
git commit -m "chore(placement): verification fixes"
```

---

## Self-Review

**Spec coverage:**
- Part 1 `deriveGuides` → Task 1. Neighbor-matched sizing (`matchedWidth`/`matchedHeight`, longest-run tiebreak) → Task 2. Guide-snapped positioning (`snapAxis`) → Task 3. Loop integration + unchanged packer/clearance/ranking → Task 4. ✓
- Part 2 remove configurable default size (types, DEFAULT_SETTINGS, settingsFile schema, CanvasSettings UI, `resolvePanelSize`, migration via tolerant load) → Task 5. ✓
- Part 3 contained overlay folder, one mount line, dev shortcut, optional `trace` sink (single source of truth), live canvas data, what-it-draws → Tasks 4 (trace) + 6 (overlay). Removal footprint documented in the component header. ✓
- Testing: helper unit tests (Tasks 1-3), `recommendPlacements` behavior + regression + trace tests (Task 4), `resolvePanelSize` test (Task 5), manual overlay verification (Task 6), full pass (Task 7). ✓

**Placeholder scan:** No TBD/TODO; all code steps include full code and exact commands/expected output.

**Type consistency:** `PlacementTrace`/`PlacementTraceStep` field names match between Task 4 definitions, the Task 4 trace test, and the Task 6 overlay (`area`, `rankAt`, `inflated`, `guides.{xs,ys}`, `steps[].{free,chosen,pinnedX,pinnedY,matchedWidth,matchedHeight,size,point}`). Helper signatures (`pinnedX(f, inflated)`, `matchedWidth(f, inflated, gap, rankAt)`, `snapAxis(lo, size, guides, tol, grid)`) are identical where defined and where called in the loop. `recommendPlacements` new param order `(…, sizeOverride?, trace?)` is consistent across Task 4 and Task 6.

**Note on green-between-tasks:** Task 2 removes the in-function `pinnedX`/`pinnedY` closures that the current loop still references; the loop is only rewritten in Task 4. To keep the suite compiling between commits, either (a) leave the closures in place during Task 2 and delete them in Task 4, or (b) run Tasks 2→4 back-to-back before relying on a green suite. This is called out in Task 2 Step 4.
