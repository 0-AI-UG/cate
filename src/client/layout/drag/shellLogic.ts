// Pure decisions the desktop shell makes for drags that leave a window:
// the cross-window drag state and its claim records, and the native ghost's
// size, position and visibility. No Electron here, so it tests without a
// window; the shell's IPC handlers gather inputs and apply the results.

import type { Point } from '@workspace/canvas/contract'
import type { CrossWindowDrag } from './ports'

// -----------------------------------------------------------------------------
// Constants, shared between handlers + tests so the values aren't duplicated
// as magic numbers in index.ts.
// -----------------------------------------------------------------------------

/** Cursor poll interval for the cross-window drag ghost, ~30 FPS. */
export const CROSS_WINDOW_POLL_MS = 33

/** How long the source window waits after broadcasting DRAG_END for some other
 *  window to claim the drop before falling back to a detach-to-new-window. */
export const CROSS_WINDOW_CLAIM_WAIT_MS = 80

/** Minimum native ghost-window size, keeps the ghost legible. */
export const GHOST_MIN_SIZE = { width: 200, height: 80 } as const

/** Maximum native ghost-window size, prevents spawning a huge screen-filling
 *  window when the source panel is enormous. */
export const GHOST_MAX_SIZE = { width: 800, height: 600 } as const

/** Default ghost size when caller passes a falsy value (e.g. 0 or NaN). */
const GHOST_DEFAULT_SIZE = { width: 320, height: 200 } as const

/** Grab offset when a drag gives none: the ghost's top-left sits a few
 *  pixels above-left of the cursor. */
const DEFAULT_GRAB_OFFSET: Point = { x: 12, y: 12 }

// -----------------------------------------------------------------------------
// Cross-window state machine
// -----------------------------------------------------------------------------

export interface CrossWindowDragState {
  /** Stable id for this drag session, rides along every DRAG_UPDATE/DRAG_END
   *  broadcast so a window only force-ends ITS OWN remote drag, and so a late
   *  RESOLVE can look up this drag's claim outcome after the live state pointer
   *  has been cleared (the claim record is keyed by this id). */
  dragId: string
  sourceWindowId: number
  drag: CrossWindowDrag
  cursor: Point
  /** True once some target window has called the drop handler. */
  claimed: boolean
  /** Timestamp (ms) when the source called resolve and started the 80ms wait,
   *  or null if resolve hasn't been called yet. */
  resolvedAt: number | null
}

/** Begin a cross-window drag. Returns the initial state. */
export function startCrossWindowDrag(args: {
  dragId: string
  sourceWindowId: number
  drag: CrossWindowDrag
  cursor: Point
}): CrossWindowDragState {
  return {
    dragId: args.dragId,
    sourceWindowId: args.sourceWindowId,
    drag: args.drag,
    cursor: { x: args.cursor.x, y: args.cursor.y },
    claimed: false,
    resolvedAt: null,
  }
}

/** Update the cursor position; returns a new state object. Pure, does not
 *  mutate `state`. */
export function updateCrossWindowCursor(
  state: CrossWindowDragState,
  cursor: Point,
): CrossWindowDragState {
  return { ...state, cursor: { x: cursor.x, y: cursor.y } }
}

/** Cancel the drag. Returns null to indicate the drag is over, callers
 *  should overwrite their module-level state with this. */
export function cancelCrossWindowDrag(_state: CrossWindowDragState | null): null {
  return null
}

/** A target window claimed the drop. Returns a new state with claimed=true,
 *  or null if there is no active drag. */
export function claimCrossWindowDrop(
  state: CrossWindowDragState | null,
  _claimedAt: number,
): CrossWindowDragState | null {
  if (!state) return null
  return { ...state, claimed: true }
}

/** The source's answer once it releases outside its window: whether a
 *  window claimed the drop. Unclaimed, the source detaches the panel into a
 *  new window. The shell waits CROSS_WINDOW_CLAIM_WAIT_MS before asking. */
export function resolveCrossWindowDrag(state: CrossWindowDragState | null): { claimed: boolean } {
  return { claimed: !!state?.claimed }
}

// -----------------------------------------------------------------------------
// Claim record, decouples the "was this drop claimed?" outcome from the live
// `crossWindowDragState` pointer. The DROP handler may clear the live state
// before the source's RESOLVE arrives (when no resolver is pending yet); a
// later RESOLVE would then read null and wrongly infer claimed=false, causing
// the source to fall back to dragDetach and DUPLICATE the panel. Keyed by
// dragId, a short-lived record survives the live-state teardown so the late
// RESOLVE observes the real outcome.
// -----------------------------------------------------------------------------

export interface ClaimRecord {
  claimed: boolean
  /** ms timestamp of when the claim was recorded. */
  at: number
}

/** Record a drop claim for a drag session. Pure: returns a new record map. */
export function recordClaim(
  records: ReadonlyMap<string, ClaimRecord>,
  dragId: string,
  claimed: boolean,
  at: number,
): Map<string, ClaimRecord> {
  const next = new Map(records)
  next.set(dragId, { claimed, at })
  return next
}

/** Look up whether a drag was claimed, honoring only records newer than
 *  `windowMs`. A missing or stale record reads as unclaimed. */
export function lookupClaim(
  records: ReadonlyMap<string, ClaimRecord>,
  dragId: string,
  now: number,
  windowMs: number,
): boolean {
  const rec = records.get(dragId)
  if (!rec) return false
  if (now - rec.at > windowMs) return false
  return rec.claimed
}

/** Drop records older than `windowMs` so the map can't grow unbounded across
 *  many drags. Pure: returns a new map. */
export function pruneClaims(
  records: ReadonlyMap<string, ClaimRecord>,
  now: number,
  windowMs: number,
): Map<string, ClaimRecord> {
  const next = new Map<string, ClaimRecord>()
  for (const [id, rec] of records) {
    if (now - rec.at <= windowMs) next.set(id, rec)
  }
  return next
}

// -----------------------------------------------------------------------------
// Ghost window position
// -----------------------------------------------------------------------------

/** Clamp a desired ghost-window size to sane bounds; substitutes a default
 *  when the input is falsy (0 / NaN) so callers can always pass through
 *  `drag.size.width` without a guard. */
export function clampGhostSize(
  width: number,
  height: number,
  bounds: { minW: number; minH: number; maxW: number; maxH: number } = {
    minW: GHOST_MIN_SIZE.width,
    minH: GHOST_MIN_SIZE.height,
    maxW: GHOST_MAX_SIZE.width,
    maxH: GHOST_MAX_SIZE.height,
  },
): { width: number; height: number } {
  const w = Math.round(Math.max(bounds.minW, Math.min(bounds.maxW, width || GHOST_DEFAULT_SIZE.width)))
  const h = Math.round(Math.max(bounds.minH, Math.min(bounds.maxH, height || GHOST_DEFAULT_SIZE.height)))
  return { width: w, height: h }
}

/** Compute the screen-space top-left for the native ghost window so the
 *  cursor lands at the grab point inside it. */
export function ghostPosition(
  cursorScreen: Point,
  grabOffset?: Point | null,
): Point {
  const ox = grabOffset?.x ?? DEFAULT_GRAB_OFFSET.x
  const oy = grabOffset?.y ?? DEFAULT_GRAB_OFFSET.y
  return { x: Math.round(cursorScreen.x - ox), y: Math.round(cursorScreen.y - oy) }
}

// -----------------------------------------------------------------------------
// Ghost-visibility decision, "should the native ghost window be hidden
// because the cursor is over an in-app window that's rendering its own
// in-renderer ghost?"
// -----------------------------------------------------------------------------

export interface GhostHostWindow {
  isDestroyed(): boolean
  getBounds(): { x: number; y: number; width: number; height: number }
  /** Tagged on the drag-ghost BrowserWindow at creation so we skip it here. */
  __isDragGhost?: boolean
}

/** True when `cursor` lies inside the bounds of any non-destroyed, non-ghost
 *  window in `windows`. The main-process poll loop uses this to decide
 *  whether to `hide()` or `showInactive()` the native drag ghost. */
export function isCursorInsideAnyAppWindow(
  cursor: Point,
  windows: readonly GhostHostWindow[],
): boolean {
  for (const w of windows) {
    if (w.isDestroyed()) continue
    if (w.__isDragGhost) continue
    const b = w.getBounds()
    if (cursor.x >= b.x && cursor.x < b.x + b.width && cursor.y >= b.y && cursor.y < b.y + b.height) {
      return true
    }
  }
  return false
}
