// =============================================================================
// Placement engine — behavioral tests for the pure recommendation algorithm:
// recommendPlacements (the numbered-ghost candidates), findFreePosition (the
// non-interactive auto-placement), and nudgeToFree (the click-anywhere escape
// hatch). Contracts under test: candidates never overlap existing nodes or each
// other, keep their clearance gap, sit on the grid, are ranked best-first
// toward the anchor/focused node, and the function always returns >= 1 spot —
// deterministically — even for degenerate inputs.
// =============================================================================

import { describe, it, expect } from 'vitest'
import {
  recommendPlacements,
  findFreePosition,
  nudgeToFree,
  deriveGuides,
  matchedNeighborSize,
  snapAxis,
  type PlacementTrace,
} from './placement'
import { CANVAS_GRID_SIZE, rectsOverlap } from './layoutEngine'
import { PANEL_DEFAULT_SIZES } from '../../shared/types'
import type { CanvasNodeId, CanvasNodeState, Point, Rect, Size } from '../../shared/types'

const TERMINAL = PANEL_DEFAULT_SIZES.terminal // 640x400

function node(
  id: string,
  x: number,
  y: number,
  w = TERMINAL.width,
  h = TERMINAL.height,
  creationIndex = 0,
): CanvasNodeState {
  return {
    id,
    panelId: `panel-${id}`,
    origin: { x, y },
    size: { width: w, height: h },
    zOrder: creationIndex,
    creationIndex,
  }
}

function nodeMap(...list: CanvasNodeState[]): Record<string, CanvasNodeState> {
  return Object.fromEntries(list.map((n) => [n.id, n]))
}

const VIEWPORT = { offset: { x: 0, y: 0 }, zoom: 1, containerSize: { width: 1200, height: 800 } }

function rectOf(c: { point: Point; size: Size }): Rect {
  return { origin: c.point, size: c.size }
}

/** Inflate a rect by m on every side — used to assert the clearance gap. */
function inflate(r: Rect, m: number): Rect {
  return {
    origin: { x: r.origin.x - m, y: r.origin.y - m },
    size: { width: r.size.width + m * 2, height: r.size.height + m * 2 },
  }
}

function expectGridAligned(p: Point) {
  // Normalize -0 from the % of negative coordinates.
  expect(Math.abs(p.x % CANVAS_GRID_SIZE)).toBe(0)
  expect(Math.abs(p.y % CANVAS_GRID_SIZE)).toBe(0)
}

describe('recommendPlacements — empty canvas', () => {
  it('returns a small set of differently-SIZED spots centred on the anchor, default best first', () => {
    const anchor = { x: 600, y: 400 }
    const out = recommendPlacements({}, null, 'terminal', VIEWPORT, anchor)

    // The exact contract for the blank-canvas case: on an empty area position is
    // irrelevant, so the picker offers SIZE choices. The default-size spot is
    // centred on the anchor (dist 0 → ranks best/first); a compact option below;
    // a larger option to the right (each ranked by offset distance from anchor).
    expect(out).toEqual([
      { point: { x: 280, y: 200 }, size: TERMINAL }, // default, centred → best
      { point: { x: 280, y: 640 }, size: { width: 420, height: 260 } }, // compact, below
      { point: { x: 960, y: 200 }, size: { width: 900, height: 560 } }, // larger, right
    ])

    // The three options must offer DISTINCT sizes (the whole point on a blank
    // area), and the best/first one is the panel default size.
    expect(out[0].size).toEqual(TERMINAL)
    const sizeKeys = out.map((c) => `${c.size.width}x${c.size.height}`)
    expect(new Set(sizeKeys).size).toBe(out.length)
  })

  it('falls back to the viewport centre without an anchor, and to a fixed origin without a viewport', () => {
    const fromViewCenter = recommendPlacements({}, null, 'terminal', VIEWPORT, null)
    // View centre (600,400) → same first spot as anchoring there explicitly.
    expect(fromViewCenter[0].point).toEqual({ x: 280, y: 200 })

    const unmeasured = recommendPlacements(
      {},
      null,
      'terminal',
      { offset: { x: 0, y: 0 }, zoom: 1, containerSize: { width: 0, height: 0 } },
      null,
    )
    expect(unmeasured.length).toBeGreaterThanOrEqual(1)
    expect(unmeasured[0].point).toEqual({ x: 100, y: 100 })
  })
})

describe('recommendPlacements — around existing nodes', () => {
  it('packs candidates around the focused node: on grid, gap-clear of the node and each other, nearest first', () => {
    const focused = node('a', 0, 0)
    // Big viewport centred on the node so every candidate is on screen and the
    // ranking is purely by distance.
    const viewport = {
      offset: { x: 1500, y: 1200 },
      zoom: 1,
      containerSize: { width: 4000, height: 3000 },
    }
    const out = recommendPlacements(nodeMap(focused), 'a', 'terminal', viewport, null)

    expect(out.length).toBeGreaterThanOrEqual(3)
    expect(out.length).toBeLessThanOrEqual(6)
    const nodeRect: Rect = { origin: focused.origin, size: focused.size }
    for (const c of out) {
      expectGridAligned(c.point)
      // Clearance: even inflated by gap-1 (39px) the candidate must not touch
      // the existing node or any other candidate.
      expect(rectsOverlap(inflate(rectOf(c), 39), nodeRect)).toBe(false)
    }
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        expect(
          rectsOverlap(inflate(rectOf(out[i]), 39), rectOf(out[j])),
          `candidates ${i} and ${j} violate the gap`,
        ).toBe(false)
      }
    }
    // Best-first: distances from the focused node's centre never decrease.
    const center = { x: 320, y: 200 }
    const dists = out.map((c) =>
      Math.hypot(c.point.x + c.size.width / 2 - center.x, c.point.y + c.size.height / 2 - center.y),
    )
    for (let i = 1; i < dists.length; i++) {
      expect(dists[i]).toBeGreaterThanOrEqual(dists[i - 1])
    }
  })

  it('with nothing focused, ranks from the cursor anchor — the best ghost fills the hole under the cursor', () => {
    // Four nodes around a central hole; the anchor sits in the hole's middle.
    const nodes = nodeMap(
      node('a', 0, 0, 640, 400, 0),
      node('b', 1360, 0, 640, 400, 1),
      node('c', 0, 880, 640, 400, 2),
      node('d', 1360, 880, 640, 400, 3),
    )
    const viewport = { offset: { x: 0, y: 0 }, zoom: 1, containerSize: { width: 2200, height: 1400 } }
    const anchor = { x: 1000, y: 640 }

    const out = recommendPlacements(nodes, null, 'terminal', viewport, anchor)

    expect(out.length).toBeGreaterThanOrEqual(1)
    // The best candidate is centred on the anchor, inside the hole.
    const best = out[0]
    expect(best.point.x + best.size.width / 2).toBeCloseTo(anchor.x, 0)
    expect(best.point.y + best.size.height / 2).toBeCloseTo(anchor.y, 0)
    for (const c of out) {
      for (const n of Object.values(nodes)) {
        expect(rectsOverlap(rectOf(c), { origin: n.origin, size: n.size })).toBe(false)
      }
    }
  })

  it('crowded grid: the interior gaps are too tight, so growth spills into the open space around it', () => {
    // 3x2 tiling with 80px gaps. Every interior gap is below the minimum panel
    // size once clearance is taken, so no candidate fills a hole — instead they
    // grow into the open space flush around the grid (default-sized, since the
    // outward axis isn't pinned), never overlapping.
    const list: CanvasNodeState[] = []
    let ci = 0
    for (const y of [0, 480]) {
      for (const x of [0, 720, 1440]) list.push(node(`n${ci}`, x, y, 640, 400, ci++))
    }
    const nodes = nodeMap(...list)
    const viewport = { offset: { x: 0, y: 0 }, zoom: 1, containerSize: { width: 2200, height: 1000 } }

    const out = recommendPlacements(nodes, null, 'terminal', viewport, { x: 1100, y: 500 })

    expect(out.length).toBeGreaterThanOrEqual(1)
    for (const c of out) {
      expectGridAligned(c.point)
      for (const n of list) {
        expect(rectsOverlap(rectOf(c), { origin: n.origin, size: n.size })).toBe(false)
      }
    }
  })

  it('panned away from every node, recommends where the camera is looking', () => {
    const nodes = nodeMap(node('a', 0, 0))
    // Offset shifts the view far right: visible canvas x in [10000, 11200].
    const viewport = { offset: { x: -10000, y: 0 }, zoom: 1, containerSize: { width: 1200, height: 800 } }

    const out = recommendPlacements(nodes, 'a', 'terminal', viewport, null)

    // Centred on the view centre (10600, 400) → standard blank-space spots.
    expect(out[0].point).toEqual({ x: 10280, y: 200 })
    for (const c of out) {
      expect(rectsOverlap(rectOf(c), { origin: { x: 0, y: 0 }, size: TERMINAL })).toBe(false)
    }
  })

  it('respects the max parameter', () => {
    const out = recommendPlacements(nodeMap(node('a', 0, 0)), 'a', 'terminal', VIEWPORT, null, 2)
    expect(out.length).toBeLessThanOrEqual(2)
    expect(out.length).toBeGreaterThanOrEqual(1)
  })

  it('mirrors the node (and placed ghosts) rather than the override whenever a neighbor is adjacent', () => {
    const size = { width: 400, height: 300 }
    const out = recommendPlacements(nodeMap(node('a', 0, 0)), 'a', 'terminal', VIEWPORT, null, 6, size)
    expect(out.length).toBeGreaterThanOrEqual(1)
    // Mirror rule: a candidate adjacent to the node OR to an already-placed ghost
    // mirrors that neighbor's FULL size (640x400) — mirroring WINS over the
    // override. Around a single node the grid tiles outward, so every candidate
    // either fully mirrors the node size, or is a residual slab whose width still
    // mirrors a neighbor (640) but whose height is clamped by the place area.
    // The override is never produced here because no spot lacks a neighbor.
    const nodeRect: Rect = { origin: { x: 0, y: 0 }, size: TERMINAL }
    let sawMirror = false
    for (const c of out) {
      const fullMirror = c.size.width === TERMINAL.width && c.size.height === TERMINAL.height
      // The override must NOT win where a neighbor is adjacent.
      const isOverride = c.size.width === size.width && c.size.height === size.height
      expect(isOverride, `override should not appear next to a neighbor: ${JSON.stringify(c)}`).toBe(false)
      // Width is always mirrored from a neighbor (640), never the override width.
      expect(c.size.width).toBe(TERMINAL.width)
      if (fullMirror) {
        sawMirror = true
        // A full mirror must actually be adjacent to the node or a placed ghost.
        const touchesNode = rectsOverlap(inflate(rectOf(c), 41), nodeRect)
        const touchesGhost = out.some(
          (o) => o !== c && rectsOverlap(inflate(rectOf(c), 41), rectOf(o)),
        )
        expect(touchesNode || touchesGhost, `mirror ${JSON.stringify(c)} is adjacent`).toBe(true)
      }
    }
    expect(sawMirror, `at least one candidate fully mirrors the node: ${JSON.stringify(out)}`).toBe(true)
  })

  it('drives the default (best) spot from the override on an empty canvas, where no neighbor exists', () => {
    // The empty-canvas path has nothing to mirror, so the override drives the
    // default size — the best/first spot. The size choices (larger/compact) are
    // scaled from that override.
    const size = { width: 400, height: 300 }
    const out = recommendPlacements({}, null, 'terminal', VIEWPORT, { x: 600, y: 400 }, 6, size)
    expect(out.length).toBeGreaterThanOrEqual(1)
    expect(out[0].size).toEqual(size) // best spot uses the override
    // The offered sizes are distinct (the point of the blank-area picker).
    const sizeKeys = out.map((c) => `${c.size.width}x${c.size.height}`)
    expect(new Set(sizeKeys).size).toBe(out.length)
  })

  it('mirrors the neighbor size into a wide bounded gap (no grow-to-fill)', () => {
    // Two 400x300 panels with a tall, wide gap between them. Under the pure mirror
    // grid a candidate in the gap mirrors a neighbor's FULL size (400x300) rather
    // than growing to fill the 800px gap — no over-wide sliver.
    const a = node('a', 0, 0, 400, 300, 0)
    const b = node('b', 1200, 0, 400, 300, 1) // gap from x=400 to x=1200 → 800 wide
    const viewport = { offset: { x: 0, y: 0 }, zoom: 1, containerSize: { width: 2400, height: 1200 } }
    const anchor = { x: 800, y: 150 } // dead centre of the gap

    const out = recommendPlacements(nodeMap(a, b), null, 'terminal', viewport, anchor)
    const filler = out.find((c) => c.point.x >= 400 && c.point.x + c.size.width <= 1200)
    expect(filler, `expected a gap candidate: ${JSON.stringify(out)}`).toBeTruthy()
    // Mirrors the neighbor's full size — NOT a 720-wide grow-to-fill tile.
    expect(filler!.size).toEqual({ width: 400, height: 300 })
    // Every candidate mirrors the (equal) neighbor size — uniform grid.
    for (const c of out) expect(c.size).toEqual({ width: 400, height: 300 })
  })

  it('uses the default size in open space — an unbounded axis never grows', () => {
    const out = recommendPlacements(nodeMap(node('a', 0, 0)), 'a', 'terminal', VIEWPORT, null)
    // Around a single node, every direction is open, so every candidate is exactly
    // the default terminal size — nothing to grow into.
    expect(out.length).toBeGreaterThanOrEqual(1)
    for (const c of out) expect(c.size).toEqual(TERMINAL)
  })

  it('is deterministic — identical inputs produce identical candidate lists', () => {
    const nodes = nodeMap(node('a', 0, 0, 640, 400, 0), node('b', 900, 300, 300, 250, 1))
    const run = () => recommendPlacements(nodes, 'a', 'terminal', VIEWPORT, { x: 777, y: 333 })
    expect(run()).toEqual(run())
  })
})

describe('recommendPlacements — degenerate inputs', () => {
  it('zero-size panel: still returns at least one spot and never produces negative sizes', () => {
    const zero = { width: 0, height: 0 }
    const empty = recommendPlacements({}, null, 'terminal', VIEWPORT, { x: 600, y: 400 }, 6, zero)
    expect(empty.length).toBeGreaterThanOrEqual(1)

    const around = recommendPlacements(
      nodeMap(node('a', 0, 0)),
      'a',
      'terminal',
      VIEWPORT,
      null,
      6,
      zero,
    )
    expect(around.length).toBeGreaterThanOrEqual(1)
    for (const c of [...empty, ...around]) {
      expect(c.size.width).toBeGreaterThanOrEqual(0)
      expect(c.size.height).toBeGreaterThanOrEqual(0)
      expect(Number.isFinite(c.point.x)).toBe(true)
      expect(Number.isFinite(c.point.y)).toBe(true)
    }
  })

  it('extreme zoom-out (huge visible area) completes and keeps candidates clear of nodes', () => {
    const nodes = nodeMap(node('a', 0, 0))
    // zoom 0.001 is floored to 0.01 internally → visible canvas 120000x80000.
    const viewport = { offset: { x: 400, y: 300 }, zoom: 0.001, containerSize: { width: 1200, height: 800 } }

    const out = recommendPlacements(nodes, 'a', 'terminal', viewport, null)

    expect(out.length).toBeGreaterThanOrEqual(1)
    expect(out.length).toBeLessThanOrEqual(6)
    for (const c of out) {
      expect(rectsOverlap(rectOf(c), { origin: { x: 0, y: 0 }, size: TERMINAL })).toBe(false)
    }
  })

  it('extreme zoom-in (tiny visible area) still returns a spot', () => {
    const nodes = nodeMap(node('a', 0, 0))
    const viewport = { offset: { x: -100, y: -100 }, zoom: 3, containerSize: { width: 1200, height: 800 } }

    const out = recommendPlacements(nodes, 'a', 'terminal', viewport, null)

    expect(out.length).toBeGreaterThanOrEqual(1)
    for (const c of out) {
      expect(rectsOverlap(rectOf(c), { origin: { x: 0, y: 0 }, size: TERMINAL })).toBe(false)
    }
  })
})

describe('findFreePosition', () => {
  it('empty canvas: returns the preferred point or the fixed default', () => {
    expect(findFreePosition({}, null, TERMINAL)).toEqual({ x: 100, y: 100 })
    // The empty-canvas path returns the preferred point VERBATIM — grid
    // snapping only kicks in once there are nodes to collide with.
    expect(findFreePosition({}, null, TERMINAL, { x: 333, y: 287 })).toEqual({ x: 333, y: 287 })
    // With any node present, the same preferred point gets snapped.
    const nodes = nodeMap(node('far', 9000, 9000))
    expect(findFreePosition(nodes, null, TERMINAL, { x: 333, y: 287 })).toEqual({ x: 340, y: 280 })
  })

  it('honors a free preferred point but searches outward when it collides', () => {
    const nodes = nodeMap(node('a', 0, 0))
    // Free preferred spot → returned as-is (already grid-aligned).
    expect(findFreePosition(nodes, 'a', TERMINAL, { x: 1000, y: 1000 })).toEqual({ x: 1000, y: 1000 })
    // Colliding preferred spot → some other, non-overlapping slot.
    const p = findFreePosition(nodes, 'a', TERMINAL, { x: 100, y: 100 })
    expect(rectsOverlap({ origin: p, size: TERMINAL }, { origin: { x: 0, y: 0 }, size: TERMINAL })).toBe(false)
  })

  it('picks the cardinal slot whose centre is nearest the reference', () => {
    const nodes = nodeMap(node('a', 0, 0)) // 640x400 → vertical slots are nearer
    const p = findFreePosition(nodes, 'a', TERMINAL)
    expect(p).toEqual({ x: 0, y: 440 }) // below, one gap away

    // Block "below" → the next-nearest (above) wins over the farther sides.
    const blocked = nodeMap(node('a', 0, 0, 640, 400, 0), node('b', 0, 440, 640, 400, 1))
    expect(findFreePosition(blocked, 'a', TERMINAL)).toEqual({ x: 0, y: -440 })
  })

  it('without a focused node, searches from the most recently created node', () => {
    const nodes = nodeMap(node('a', 0, 0, 640, 400, 0), node('b', 5000, 5000, 640, 400, 7))
    const p = findFreePosition(nodes, null, TERMINAL)
    // Adjacent to b (the highest creationIndex), not to a.
    expect(Math.hypot(p.x - 5000, p.y - 5000)).toBeLessThan(1000)
    for (const n of Object.values(nodes)) {
      expect(rectsOverlap({ origin: p, size: TERMINAL }, { origin: n.origin, size: n.size })).toBe(false)
    }
  })
})

describe('nudgeToFree', () => {
  it('returns the snapped desired point when it is already free', () => {
    const nodes = nodeMap(node('a', 0, 0))
    expect(nudgeToFree(nodes, { width: 200, height: 200 }, { x: 1007, y: 993 })).toEqual({ x: 1000, y: 1000 })
  })

  it('spirals off an occupied spot to a grid-aligned free position', () => {
    const nodes = nodeMap(node('a', 0, 0))
    const size = { width: 200, height: 200 }

    const p = nudgeToFree(nodes, size, { x: 100, y: 100 }) // dead centre of the node

    expectGridAligned(p)
    expect(rectsOverlap({ origin: p, size }, { origin: { x: 0, y: 0 }, size: TERMINAL })).toBe(false)
  })

  it('gives up and allows the overlap when everything within the search ring is covered', () => {
    // One node blankets the entire spiral search radius (25 rings x 40px = 1000px).
    const nodes = nodeMap(node('blanket', -2000, -2000, 4000, 4000))
    const size = { width: 100, height: 100 }

    const p = nudgeToFree(nodes, size, { x: 0, y: 0 })

    // Documented give-up contract: the start point is returned even though it
    // overlaps, rather than refusing the placement.
    expect(p).toEqual({ x: 0, y: 0 })
    expect(rectsOverlap({ origin: p, size }, { origin: { x: -2000, y: -2000 }, size: { width: 4000, height: 4000 } })).toBe(true)
  })
})

describe('matchedNeighborSize', () => {
  // A window inflated by gap=40. Window A: origin (1000,1000) size 600x400.
  const inflateWin = (x: number, y: number, w: number, h: number, gap = 40): Rect => ({
    origin: { x: x - gap, y: y - gap },
    size: { width: w + gap * 2, height: h + gap * 2 },
  })

  it('mirrors the full size of a window directly above the free rect', () => {
    // A at (1000,1000,600,400) inflated → bottom edge at 1440.
    const A = inflateWin(1000, 1000, 600, 400)
    // free rect spanning below A
    const f = { origin: { x: 0, y: 1440 }, size: { width: 4000, height: 2000 } }
    expect(matchedNeighborSize(f, [A], 40, { x: 1300, y: 1600 })).toEqual({ width: 600, height: 400 })
  })

  it('mirrors the full size of a window directly left of the free rect', () => {
    const A = inflateWin(1000, 1000, 600, 400) // right edge at 1640
    const f = { origin: { x: 1640, y: 0 }, size: { width: 2000, height: 4000 } }
    expect(matchedNeighborSize(f, [A], 40, { x: 1900, y: 1200 })).toEqual({ width: 600, height: 400 })
  })

  it('returns null when no neighbor touches the rect', () => {
    const A = inflateWin(1000, 1000, 600, 400)
    const f = { origin: { x: 3000, y: 3000 }, size: { width: 500, height: 500 } }
    expect(matchedNeighborSize(f, [A], 40, { x: 3250, y: 3250 })).toBeNull()
  })
})

describe('deriveGuides', () => {
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

describe('recommendPlacements — neighbor-aware sizing', () => {
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

  const VP = { offset: { x: 0, y: 0 }, zoom: 1, containerSize: { width: 4000, height: 4000 } }

  it('mirrors the full size of a window directly above (stacked)', () => {
    const ns = nodesOf(node(1000, 1000, 600, 400))
    const out = recommendPlacements(ns, null, 'editor', VP, { x: 1300, y: 1600 })
    expect(out[0].size.width).toBe(600)        // mirrored A's width
    expect(out[0].size.height).toBe(400)       // mirrored A's height too (was the default)
    expect(out[0].point.x).toBe(1000)          // aligned to A's left edge
    expect(out[0].point.y).toBe(1440)          // 40px gap below A (1400 + 40)
  })

  it('mirrors the full size of a window to the left (side-by-side)', () => {
    const ns = nodesOf(node(1000, 1000, 600, 400))
    const out = recommendPlacements(ns, null, 'editor', VP, { x: 1900, y: 1200 })
    expect(out[0].size.width).toBe(600)        // mirrored A's width too (was the default)
    expect(out[0].size.height).toBe(400)       // mirrored A's height
    expect(out[0].point.y).toBe(1000)          // aligned to A's top edge
  })

  it('a narrow interior gap is SKIPPED, not filled (no grow-to-fill)', () => {
    // Two 600-wide windows one gap apart leave a 320px interior gap. Under the pure
    // mirror grid the gap would mirror a 600-wide neighbor, which does NOT fit 320,
    // so the gap is skipped — there is no shrunken 320-wide sliver. Every candidate
    // mirrors a 600-wide neighbor instead.
    const ns = nodesOf(node(1000, 1000, 600, 400), node(2000, 1000, 600, 400))
    const out = recommendPlacements(ns, null, 'editor', VP, { x: 1800, y: 1200 })
    expect(out.length).toBeGreaterThanOrEqual(1)
    expect(out.some((c) => c.size.width === 320)).toBe(false) // no fill sliver
    for (const c of out) expect(c.size.width).toBe(600)       // pure mirror grid
  })

  it('uses default size on an empty canvas (regression)', () => {
    const out = recommendPlacements({}, null, 'editor', VP, { x: 500, y: 500 })
    expect(out.length).toBeGreaterThanOrEqual(1)
    expect(out[0].size).toEqual({ width: 600, height: 500 })
  })

  it('placed ghosts act as neighbors so the grid tiles uniformly outward', () => {
    // A single 600x400 window (NOT the 600x500 editor default). Across a large
    // area, the packer chains every spot off the window: the first-row ghosts
    // mirror the window, and every later spot — though not adjacent to the real
    // window — mirrors an already-placed ghost. So ALL candidates are 600x400.
    // Before this change the second-row/far spots fell back to the editor
    // default height (500), producing an out-of-place smaller box.
    const ns = nodesOf(node(0, 0, 600, 400))
    const VPbig = { offset: { x: 0, y: 0 }, zoom: 1, containerSize: { width: 4000, height: 3000 } }
    const out = recommendPlacements(ns, null, 'editor', VPbig, { x: 300, y: 200 }, 8)
    expect(out.length).toBeGreaterThanOrEqual(6)
    for (const c of out) {
      expect(c.size, `candidate ${JSON.stringify(c)} mirrors the window, not the default`)
        .toEqual({ width: 600, height: 400 })
    }
    // Specifically: a second-row candidate (below the first row, not touching
    // the real window) exists and mirrors the ghost above it.
    const secondRow = out.find((c) => c.point.y >= 880)
    expect(secondRow, `expected a second-row candidate: ${JSON.stringify(out)}`).toBeTruthy()
    expect(secondRow!.size).toEqual({ width: 600, height: 400 })
  })

  it('keeps guide-aligned off-grid spots a non-grid neighbor produces', () => {
    // Regression: a window with a non-grid size (402.5 tall) makes the packer
    // align mirror tiles to off-grid neighbor-edge guides. finalize must NOT
    // re-snap those to the 20px grid — doing so nudged a tile ~2.5px toward its
    // neighbor, cutting clearance below the gap, and finalize then dropped it.
    // Layout: a terminal-size window above a browser-size window, browser focused.
    const terminal = node(1000, 1000, 640, 402.5)
    const browser = node(820, 1480, 1000, 640)
    const ns = nodesOf(terminal, browser)
    const vp = { offset: { x: 0, y: 0 }, zoom: 1, containerSize: { width: 3000, height: 2500 } }
    const out = recommendPlacements(ns, browser.id, 'browser', vp, null, 6, { width: 800, height: 600 })
    // All six packed spots survive (before the fix only the three grid-aligned
    // browser-mirror spots did; the three off-grid terminal-mirror spots were dropped).
    expect(out.length).toBe(6)
    // The terminal-mirror tiles are present and keep their off-grid (guide) position.
    const terminalMirrors = out.filter((c) => c.size.width === 640 && c.size.height === 402.5)
    expect(terminalMirrors.length).toBe(3)
    expect(terminalMirrors.some((c) => c.point.y === 557.5 || c.point.y === 1037.5)).toBe(true)
  })

  it('uniform mirror grid: no over-wide fill tiles', () => {
    // Regression for the user's fix. Focused F=600x400 between two 400x400 side
    // windows at a different row. Previously grow-to-fill produced a 760-wide tile
    // in the gap between WL/WR (wider than the 600 window). Under the pure mirror
    // grid every spot mirrors an existing window's full size: NO candidate is wider
    // than 600, and every candidate's size equals an existing window's size.
    const F = node(1000, 1500, 600, 400)
    const WL = node(200, 700, 400, 400)
    const WR = node(1800, 700, 400, 400)
    const ns = nodesOf(F, WL, WR)
    const VPbig = { offset: { x: 0, y: 0 }, zoom: 1, containerSize: { width: 4000, height: 4000 } }
    const out = recommendPlacements(ns, Object.keys(ns)[0], 'editor', VPbig, null, 8, { width: 600, height: 400 })
    expect(out.length).toBeGreaterThanOrEqual(1)
    const existing = [
      { width: 600, height: 400 },
      { width: 400, height: 400 },
    ]
    for (const c of out) {
      expect(c.size.width, `no over-wide fill tile: ${JSON.stringify(c)}`).toBeLessThanOrEqual(600)
      expect(
        existing.some((s) => s.width === c.size.width && s.height === c.size.height),
        `candidate mirrors an existing window size: ${JSON.stringify(c)}`,
      ).toBe(true)
    }
  })

  it('skips a rect too small for the mirror — no shrunken sliver', () => {
    // A 600-wide window with a 320px interior gap on its right (a second 600-wide
    // window one gap further). The gap mirrors a 600 neighbor, which does not fit
    // 320, so the gap is skipped: no candidate is narrower than 600 beyond FIT_TOL.
    const ns = nodesOf(node(1000, 1000, 600, 400), node(2000, 1000, 600, 400))
    const out = recommendPlacements(ns, null, 'editor', VP, { x: 1800, y: 1200 })
    expect(out.length).toBeGreaterThanOrEqual(1)
    const FIT_TOL = CANVAS_GRID_SIZE
    for (const c of out) {
      expect(c.size.width, `no sliver narrower than the mirror: ${JSON.stringify(c)}`)
        .toBeGreaterThanOrEqual(600 - FIT_TOL)
    }
  })

  it('fills a useful empty gap that matches no neighbor (grow-to-fill)', () => {
    // A center gap bounded by mismatched-size neighbors: a wide window above and
    // below (1500x200) and tall narrow windows left/right (300x600). The longest-
    // shared-run neighbor is the wide above/below window, whose 1500 width does NOT
    // fit the 820-wide interior gap, so the mirror is rejected — but the gap is
    // >= USEFUL_MIN in both dimensions, so it GROWS TO FILL rather than being
    // skipped. (Under the old pure-mirror rule this obvious empty gap got nothing.)
    const above = node(0, 0, 1500, 200)
    const left = node(0, 240, 300, 600)
    const right = node(1200, 240, 300, 600)
    const below = node(0, 880, 1500, 200)
    const ns = nodesOf(above, left, right, below)
    const vp = { offset: { x: 0, y: 0 }, zoom: 1, containerSize: { width: 1500, height: 1080 } }
    const trace: PlacementTrace = {
      area: { origin: { x: 0, y: 0 }, size: { width: 0, height: 0 } },
      rankAt: { x: 0, y: 0 }, inflated: [], guides: { xs: [], ys: [] }, steps: [],
    }
    const out = recommendPlacements(ns, null, 'editor', vp, { x: 750, y: 540 }, 6, undefined, trace)
    // A candidate appears in the center gap, sized to (approximately) the gap.
    const gapCand = out.find(
      (c) => c.point.x >= 300 && c.point.x + c.size.width <= 1200 &&
             c.point.y >= 200 && c.point.y + c.size.height <= 880,
    )
    expect(gapCand, `expected a grow-to-fill candidate in the gap: ${JSON.stringify(out)}`).toBeTruthy()
    // Grow-to-fill: it spans (about) the whole interior gap — 820 wide x 600 tall —
    // which is wider than every neighbor (none is 820 wide).
    expect(gapCand!.size).toEqual({ width: 820, height: 600 })
    // Good aspect ratio (820/600 ~= 1.37) sits inside the terminal's AR band
    // [1.0, 2.56], so the fill AR guard does NOT over-reject this useful gap.
    const ar = gapCand!.size.width / gapCand!.size.height
    expect(ar).toBeGreaterThan(1.0)
    expect(ar).toBeLessThan(2.56)
    // The trace marks the step as a fill (no mirror match).
    const filledStep = trace.steps.find((s) => s.filled)
    expect(filledStep, 'a filled step is recorded').toBeTruthy()
    expect(filledStep!.matchedWidth).toBeNull()
    expect(filledStep!.matchedHeight).toBeNull()
  })

  it('skips a grow-to-fill gap with an awkward aspect ratio (tall/narrow)', () => {
    // A tall, narrow vertical channel between two tall side windows, capped by wide
    // windows above and below. The longest-shared-run neighbor (a side window) is
    // 500 wide and does NOT fit the channel, so the gap would grow-to-fill — and it
    // is >= USEFUL_MIN in both dimensions (460 x 900), so the size guard passes.
    // But its shape (AR 460/900 ~= 0.51) is far below the terminal's natural AR
    // (640/400 = 1.6, band [1.0, 2.56]), so the AR guard SKIPS it: no awkward
    // tall/narrow fill tile is offered in the channel.
    const above = node(0, 0, 1600, 200)
    const left = node(0, 240, 500, 900)
    const right = node(1040, 240, 500, 900) // raw channel x 500..1040 -> post-gap 460 wide
    const below = node(0, 1180, 1600, 200) // raw channel y 200..1180 -> post-gap 900 tall
    const ns = nodesOf(above, left, right, below)
    const vp = { offset: { x: 0, y: 0 }, zoom: 1, containerSize: { width: 1600, height: 1380 } }
    const trace: PlacementTrace = {
      area: { origin: { x: 0, y: 0 }, size: { width: 0, height: 0 } },
      rankAt: { x: 0, y: 0 }, inflated: [], guides: { xs: [], ys: [] }, steps: [],
    }
    const out = recommendPlacements(ns, null, 'terminal', vp, { x: 770, y: 690 }, 6, undefined, trace)
    // No candidate sits inside the tall/narrow channel.
    const channelCand = out.find(
      (c) => c.point.x >= 500 && c.point.x + c.size.width <= 1040 &&
             c.point.y >= 200 && c.point.y + c.size.height <= 1180,
    )
    expect(channelCand, `no fill candidate expected in the awkward channel: ${JSON.stringify(out)}`).toBeUndefined()
    // No candidate has the bad-AR 460x900 fill size, and no fill step was recorded.
    expect(out.some((c) => c.size.width === 460 && c.size.height === 900)).toBe(false)
    expect(trace.steps.some((s) => s.filled)).toBe(false)
  })

  it('skips a thin sliver gap (one dimension below USEFUL_MIN) — no grow-to-fill', () => {
    // Same shape as the grow-to-fill case but the center gap is only 320 wide
    // (< USEFUL_MIN_W = 400). The mirror of the wide above/below neighbor does not
    // fit either, so this would be a grow-to-fill candidate — but it is too thin to
    // be useful, so it is SKIPPED rather than producing a sliver in the gap.
    const above = node(0, 0, 1500, 300)
    const left = node(0, 340, 500, 600)
    const right = node(900, 340, 500, 600) // gap x 540..860 → 320 wide
    const below = node(0, 980, 1500, 300)
    const ns = nodesOf(above, left, right, below)
    const vp = { offset: { x: 0, y: 0 }, zoom: 1, containerSize: { width: 1400, height: 1280 } }
    const out = recommendPlacements(ns, null, 'editor', vp, { x: 700, y: 640 }, 6)
    // No candidate squeezes into the thin 320px center gap.
    const sliver = out.find(
      (c) => c.point.x > 500 && c.point.x + c.size.width < 900 &&
             c.point.y > 340 && c.point.y + c.size.height < 940,
    )
    expect(sliver, `no sliver candidate expected: ${JSON.stringify(out)}`).toBeUndefined()
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
    expect(s.matchedHeight).toBe(400) // mirror rule now sizes BOTH axes from the neighbor
  })
})
