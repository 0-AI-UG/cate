import { describe, it, expect } from 'vitest'
import {
  startCrossWindowDrag,
  updateCrossWindowCursor,
  cancelCrossWindowDrag,
  claimCrossWindowDrop,
  resolveCrossWindowDrag,
  recordClaim,
  lookupClaim,
  pruneClaims,
  decideDetach,
  clampGhostSize,
  ghostPosition,
  isCursorInsideAnyAppWindow,
  CROSS_WINDOW_CLAIM_WAIT_MS,
  GHOST_MIN_SIZE,
  GHOST_MAX_SIZE,
  type ClaimRecord,
  type GhostHostWindow,
} from './dragLogic'
import type { PanelTransferSnapshot } from '../shared/types'

function makeSnapshot(): PanelTransferSnapshot {
  return {
    panel: { id: 'p1', type: 'editor', title: 'Test' } as PanelTransferSnapshot['panel'],
    geometry: { origin: { x: 0, y: 0 }, size: { width: 320, height: 200 } },
    sourceLocation: { kind: 'canvas' } as unknown as PanelTransferSnapshot['sourceLocation'],
  }
}

describe('decideDetach', () => {
  const baseCtx = {
    anyWindowFullscreen: false,
    cursor: { x: 500, y: 400 },
    grabOffset: { x: 12, y: 12 },
    size: { width: 700, height: 500 },
    displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
  }

  it('refuses when any window is fullscreen', () => {
    const decision = decideDetach({ ...baseCtx, anyWindowFullscreen: true })
    expect(decision).toEqual({ kind: 'refuse', reason: 'fullscreen' })
  })

  it('positions so cursor lands at the grab offset inside the new window', () => {
    const decision = decideDetach(baseCtx)
    if (decision.kind !== 'create-window') throw new Error('expected create-window')
    // cursor (500, 400) - grabOffset (12, 12) = (488, 388)
    expect(decision.position).toEqual({ x: 488, y: 388 })
    expect(decision.size).toEqual({ width: 700, height: 500 })
  })

  it('clamps position so window stays inside display (right/bottom)', () => {
    const decision = decideDetach({
      ...baseCtx,
      cursor: { x: 1900, y: 1070 },
      displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    })
    if (decision.kind !== 'create-window') throw new Error('expected create-window')
    // maxX = 1920 - 700 = 1220, maxY = 1080 - 500 = 580
    expect(decision.position.x).toBe(1220)
    expect(decision.position.y).toBe(580)
  })

  it('clamps position so window stays inside display (left/top)', () => {
    const decision = decideDetach({
      ...baseCtx,
      cursor: { x: 5, y: 5 },
      displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    })
    if (decision.kind !== 'create-window') throw new Error('expected create-window')
    expect(decision.position).toEqual({ x: 0, y: 0 })
  })

  it('respects a non-origin display (multi-monitor)', () => {
    const decision = decideDetach({
      ...baseCtx,
      cursor: { x: 2000, y: 200 },
      displayBounds: { x: 1920, y: 0, width: 1920, height: 1080 },
    })
    if (decision.kind !== 'create-window') throw new Error('expected create-window')
    // raw = (1988, 188); clamped within [1920, 1920+1920-700=3140] -> 1988
    expect(decision.position.x).toBe(1988)
    expect(decision.position.y).toBe(188)
  })

  it('anchors at display origin when the window is larger than the display', () => {
    const decision = decideDetach({
      ...baseCtx,
      cursor: { x: 100, y: 100 },
      size: { width: 3000, height: 2000 },
      displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    })
    if (decision.kind !== 'create-window') throw new Error('expected create-window')
    expect(decision.position).toEqual({ x: 0, y: 0 })
  })
})

describe('clampGhostSize', () => {
  it('clamps width below the minimum up to the minimum', () => {
    expect(clampGhostSize(50, 300).width).toBe(GHOST_MIN_SIZE.width)
  })

  it('clamps width above the maximum down to the maximum', () => {
    expect(clampGhostSize(5000, 300).width).toBe(GHOST_MAX_SIZE.width)
  })

  it('clamps height below the minimum up to the minimum', () => {
    expect(clampGhostSize(300, 10).height).toBe(GHOST_MIN_SIZE.height)
  })

  it('clamps height above the maximum down to the maximum', () => {
    expect(clampGhostSize(300, 5000).height).toBe(GHOST_MAX_SIZE.height)
  })

  it('passes mid-range values through unchanged (rounded)', () => {
    expect(clampGhostSize(400, 300)).toEqual({ width: 400, height: 300 })
  })

  it('substitutes a default when given falsy size (0)', () => {
    const r = clampGhostSize(0, 0)
    expect(r.width).toBeGreaterThanOrEqual(GHOST_MIN_SIZE.width)
    expect(r.height).toBeGreaterThanOrEqual(GHOST_MIN_SIZE.height)
  })
})

describe('ghostPosition', () => {
  it('subtracts the grab offset from the cursor', () => {
    expect(ghostPosition({ x: 100, y: 200 }, { x: 12, y: 12 })).toEqual({ x: 88, y: 188 })
  })

  it('uses the default grab offset when none is given', () => {
    expect(ghostPosition({ x: 100, y: 200 })).toEqual({ x: 88, y: 188 })
  })

  it('uses the default grab offset when null is given', () => {
    expect(ghostPosition({ x: 100, y: 200 }, null)).toEqual({ x: 88, y: 188 })
  })
})

describe('cross-window state machine', () => {
  it('startCrossWindowDrag initializes claimed=false, resolvedAt=null', () => {
    const s = startCrossWindowDrag({
      dragId: 'd1',
      sourceWindowId: 7,
      snapshot: makeSnapshot(),
      cursor: { x: 10, y: 20 },
    })
    expect(s.dragId).toBe('d1')
    expect(s.sourceWindowId).toBe(7)
    expect(s.cursor).toEqual({ x: 10, y: 20 })
    expect(s.claimed).toBe(false)
    expect(s.resolvedAt).toBeNull()
  })

  it('updateCrossWindowCursor updates cursor without changing other fields', () => {
    const s0 = startCrossWindowDrag({
      dragId: 'd1',
      sourceWindowId: 7,
      snapshot: makeSnapshot(),
      cursor: { x: 10, y: 20 },
    })
    const s1 = updateCrossWindowCursor(s0, { x: 99, y: 100 })
    expect(s1.cursor).toEqual({ x: 99, y: 100 })
    expect(s1.sourceWindowId).toBe(s0.sourceWindowId)
    expect(s1.snapshot).toBe(s0.snapshot)
    expect(s1.claimed).toBe(s0.claimed)
    // Pure — original is unchanged.
    expect(s0.cursor).toEqual({ x: 10, y: 20 })
  })

  it('claimCrossWindowDrop(null) returns null', () => {
    expect(claimCrossWindowDrop(null, 0)).toBeNull()
  })

  it('claimCrossWindowDrop(state) sets claimed=true', () => {
    const s0 = startCrossWindowDrag({
      dragId: 'd1',
      sourceWindowId: 7,
      snapshot: makeSnapshot(),
      cursor: { x: 0, y: 0 },
    })
    const s1 = claimCrossWindowDrop(s0, 1234)
    expect(s1?.claimed).toBe(true)
    // Pure — original is unchanged.
    expect(s0.claimed).toBe(false)
  })

  it('resolveCrossWindowDrag(null) → unclaimed, do not remove', () => {
    expect(resolveCrossWindowDrag(null)).toEqual({
      claimed: false,
      removeFromSource: false,
    })
  })

  it('resolveCrossWindowDrag(claimed state) → claimed, remove from source', () => {
    const s = claimCrossWindowDrop(
      startCrossWindowDrag({
        dragId: 'd1',
        sourceWindowId: 7,
        snapshot: makeSnapshot(),
        cursor: { x: 0, y: 0 },
      }),
      0,
    )
    expect(resolveCrossWindowDrag(s)).toEqual({
      claimed: true,
      removeFromSource: true,
    })
  })

  it('resolveCrossWindowDrag(unclaimed state) → unclaimed, do not remove', () => {
    const s = startCrossWindowDrag({
      dragId: 'd1',
      sourceWindowId: 7,
      snapshot: makeSnapshot(),
      cursor: { x: 0, y: 0 },
    })
    expect(resolveCrossWindowDrag(s)).toEqual({
      claimed: false,
      removeFromSource: false,
    })
  })

  it('cancelCrossWindowDrag(state) returns null', () => {
    const s = startCrossWindowDrag({
      dragId: 'd1',
      sourceWindowId: 7,
      snapshot: makeSnapshot(),
      cursor: { x: 0, y: 0 },
    })
    expect(cancelCrossWindowDrag(s)).toBeNull()
  })

  it('cancelCrossWindowDrag(null) returns null', () => {
    expect(cancelCrossWindowDrag(null)).toBeNull()
  })
})

// -----------------------------------------------------------------------------
// Claim records — decouple the "was this drop claimed?" outcome from the live
// drag-state pointer so a RESOLVE arriving AFTER a DROP cleared the live state
// (the no-pending-resolver path) still reads claimed=true. The bug this guards:
// a late RESOLVE reading a nulled pointer returned claimed=false, so commit.ts
// fell back to dragDetach and DUPLICATED the panel.
// -----------------------------------------------------------------------------

describe('cross-window claim records', () => {
  const WAIT = CROSS_WINDOW_CLAIM_WAIT_MS

  it('records and looks up a claim within the wait window', () => {
    let recs: ReadonlyMap<string, ClaimRecord> = new Map()
    recs = recordClaim(recs, 'drag-1', true, 1000)
    expect(lookupClaim(recs, 'drag-1', 1000 + WAIT, WAIT)).toBe(true)
  })

  it('DROP-before-RESOLVE with no pending resolver still yields claimed=true', () => {
    // Simulate the exact race: DROP claims + records, then clears the live
    // state (no resolver pending). A subsequent RESOLVE has a null live
    // pointer, so it must consult the claim record by dragId.
    const dropAt = 5000
    let live = claimCrossWindowDrop(
      startCrossWindowDrag({
        dragId: 'drag-race',
        sourceWindowId: 1,
        snapshot: makeSnapshot(),
        cursor: { x: 0, y: 0 },
      }),
      dropAt,
    )
    let recs: ReadonlyMap<string, ClaimRecord> = new Map()
    recs = recordClaim(recs, 'drag-race', true, dropAt)
    // DROP clears the live state because no resolver was armed.
    live = cancelCrossWindowDrag(live)
    expect(live).toBeNull()

    // RESOLVE arrives shortly after: live pointer is null, so it falls back to
    // the claim record — which still says claimed.
    const resolveAt = dropAt + 20
    const liveDecision = resolveCrossWindowDrag(live) // { claimed: false } (null state)
    const claimed =
      liveDecision.claimed || lookupClaim(recs, 'drag-race', resolveAt, WAIT)
    expect(claimed).toBe(true)
  })

  it('lookupClaim returns false for an unknown drag', () => {
    expect(lookupClaim(new Map(), 'nope', 1000, WAIT)).toBe(false)
  })

  it('lookupClaim returns false for a stale record (older than the window)', () => {
    let recs: ReadonlyMap<string, ClaimRecord> = new Map()
    recs = recordClaim(recs, 'old', true, 1000)
    expect(lookupClaim(recs, 'old', 1000 + WAIT + 1, WAIT)).toBe(false)
  })

  it('pruneClaims drops records older than the window, keeps fresh ones', () => {
    let recs: ReadonlyMap<string, ClaimRecord> = new Map()
    recs = recordClaim(recs, 'old', true, 1000)
    recs = recordClaim(recs, 'fresh', true, 2000)
    const pruned = pruneClaims(recs, 2000 + WAIT, WAIT)
    expect(pruned.has('old')).toBe(false)
    expect(pruned.has('fresh')).toBe(true)
  })

  it('recordClaim is pure — original map is unchanged', () => {
    const recs: ReadonlyMap<string, ClaimRecord> = new Map()
    const next = recordClaim(recs, 'd', true, 0)
    expect(recs.size).toBe(0)
    expect(next.size).toBe(1)
  })
})

// -----------------------------------------------------------------------------
// isCursorInsideAnyAppWindow — pins the "hide the native ghost when cursor is
// over any Cate window" decision. The bug this prevents: dragging a panel out
// of a detached window and back over the main app rendered TWO ghosts (the
// native ghost + the in-renderer DragOverlay) until drop.
// -----------------------------------------------------------------------------

function fakeWin(
  bounds: { x: number; y: number; width: number; height: number },
  opts: { destroyed?: boolean; isGhost?: boolean } = {},
): GhostHostWindow {
  return {
    isDestroyed: () => opts.destroyed ?? false,
    getBounds: () => bounds,
    __isDragGhost: opts.isGhost,
  }
}

describe('isCursorInsideAnyAppWindow', () => {
  it('returns true when cursor lies inside one of the windows', () => {
    const wins = [
      fakeWin({ x: 0, y: 0, width: 800, height: 600 }),
      fakeWin({ x: 1000, y: 100, width: 400, height: 300 }),
    ]
    expect(isCursorInsideAnyAppWindow({ x: 1200, y: 250 }, wins)).toBe(true)
  })

  it('returns false when cursor is in the gap between windows', () => {
    const wins = [
      fakeWin({ x: 0, y: 0, width: 800, height: 600 }),
      fakeWin({ x: 1000, y: 0, width: 400, height: 600 }),
    ]
    expect(isCursorInsideAnyAppWindow({ x: 900, y: 300 }, wins)).toBe(false)
  })

  it('ignores the drag-ghost window itself (tagged via __isDragGhost)', () => {
    // The ghost follows the cursor — without the skip, cursor would always be
    // "inside" the ghost and we'd hide it forever.
    const wins = [
      fakeWin({ x: 100, y: 100, width: 200, height: 100 }, { isGhost: true }),
    ]
    expect(isCursorInsideAnyAppWindow({ x: 150, y: 150 }, wins)).toBe(false)
  })

  it('ignores destroyed windows', () => {
    const wins = [fakeWin({ x: 0, y: 0, width: 800, height: 600 }, { destroyed: true })]
    expect(isCursorInsideAnyAppWindow({ x: 100, y: 100 }, wins)).toBe(false)
  })

  it('right/bottom edges are exclusive (cursor at width/height is OUT)', () => {
    const wins = [fakeWin({ x: 0, y: 0, width: 100, height: 100 })]
    expect(isCursorInsideAnyAppWindow({ x: 100, y: 50 }, wins)).toBe(false)
    expect(isCursorInsideAnyAppWindow({ x: 50, y: 100 }, wins)).toBe(false)
    expect(isCursorInsideAnyAppWindow({ x: 99, y: 99 }, wins)).toBe(true)
  })

  it('left/top edges are inclusive (cursor at x,y is IN)', () => {
    const wins = [fakeWin({ x: 50, y: 50, width: 100, height: 100 })]
    expect(isCursorInsideAnyAppWindow({ x: 50, y: 50 }, wins)).toBe(true)
  })

  it('empty window list → false (no app windows means show the ghost)', () => {
    expect(isCursorInsideAnyAppWindow({ x: 100, y: 100 }, [])).toBe(false)
  })
})
