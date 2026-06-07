// =============================================================================
// dragLogic — pure decision functions for cross-window drag, detach, and
// ghost-window positioning. This module has ZERO Electron imports so it can
// be unit-tested without launching a BrowserWindow.
//
// The IPC handlers in index.ts are thin adapters: they gather inputs from the
// Electron screen/window APIs, call into here for the decision/math, then
// perform the resulting side effects (create a window, move the ghost, etc).
// =============================================================================

import type { Point, PanelTransferSnapshot } from '../shared/types'

// -----------------------------------------------------------------------------
// Constants — shared between handlers + tests so the values aren't duplicated
// as magic numbers in index.ts.
// -----------------------------------------------------------------------------

/** Cursor poll interval for the cross-window drag ghost — ~30 FPS. */
export const CROSS_WINDOW_POLL_MS = 33

/** How long the source window waits after broadcasting DRAG_END for some other
 *  window to claim the drop before falling back to a detach-to-new-window. */
export const CROSS_WINDOW_CLAIM_WAIT_MS = 80

/** Minimum native ghost-window size — keeps the ghost legible. */
export const GHOST_MIN_SIZE = { width: 200, height: 80 } as const

/** Maximum native ghost-window size — prevents spawning a huge screen-filling
 *  window when the source panel is enormous. */
export const GHOST_MAX_SIZE = { width: 800, height: 600 } as const

/** Default ghost size when caller passes a falsy value (e.g. 0 or NaN). */
const GHOST_DEFAULT_SIZE = { width: 320, height: 200 } as const

/** Default cursor-grab offset used when a snapshot doesn't provide one — the
 *  drop target's top-left lands a few pixels above-left of the cursor. */
const DEFAULT_GRAB_OFFSET: Point = { x: 12, y: 12 }

// -----------------------------------------------------------------------------
// Cross-window state machine
// -----------------------------------------------------------------------------

export interface CrossWindowDragState {
  /** Stable id for this drag session — rides along every DRAG_UPDATE/DRAG_END
   *  broadcast so a window only force-ends ITS OWN remote drag, and so a late
   *  RESOLVE can look up this drag's claim outcome after the live state pointer
   *  has been cleared (the claim record is keyed by this id). */
  dragId: string
  sourceWindowId: number
  snapshot: PanelTransferSnapshot
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
  snapshot: PanelTransferSnapshot
  cursor: Point
}): CrossWindowDragState {
  return {
    dragId: args.dragId,
    sourceWindowId: args.sourceWindowId,
    snapshot: args.snapshot,
    cursor: { x: args.cursor.x, y: args.cursor.y },
    claimed: false,
    resolvedAt: null,
  }
}

/** Update the cursor position; returns a new state object. Pure — does not
 *  mutate `state`. */
export function updateCrossWindowCursor(
  state: CrossWindowDragState,
  cursor: Point,
): CrossWindowDragState {
  return { ...state, cursor: { x: cursor.x, y: cursor.y } }
}

/** Cancel the drag. Returns null to indicate the drag is over — callers
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

/**
 * Decision for the source window once it calls RESOLVE:
 *  - `claimed: true` → some target already accepted the drop; the source must
 *    remove the original node from its canvas.
 *  - `claimed: false, removeFromSource: false` → nobody claimed it; the caller
 *    should fall back to detach-to-new-window (which itself handles the
 *    source-removal as part of the move).
 *
 * The claim-wait is implemented externally by the IPC handler (a setTimeout
 * around the resolve promise); this function just inspects the final state.
 */
export function resolveCrossWindowDrag(
  state: CrossWindowDragState | null,
): { claimed: boolean; removeFromSource: boolean } {
  if (!state) return { claimed: false, removeFromSource: false }
  if (state.claimed) return { claimed: true, removeFromSource: true }
  return { claimed: false, removeFromSource: false }
}

// -----------------------------------------------------------------------------
// Claim record — decouples the "was this drop claimed?" outcome from the live
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
// Detach decision — "the user dropped on empty space, should we spawn a new
// dock window and where should it land?"
// -----------------------------------------------------------------------------

export interface DetachContext {
  /** True when some Cate window is in macOS native fullscreen — new windows
   *  would land in a separate Space (black screen), so we refuse. */
  anyWindowFullscreen: boolean
  /** Cursor position in screen pixels at the moment of the drop. */
  cursor: Point
  /** How far inside the original panel the user grabbed (px). Used so the
   *  cursor stays at the same point inside the new window. */
  grabOffset: Point
  /** Desired size of the new window — usually the source panel's geometry. */
  size: { width: number; height: number }
  /** Bounds of the display the new window will live on. Used to clamp the
   *  final position so the window isn't (mostly) off-screen. */
  displayBounds: { x: number; y: number; width: number; height: number }
}

export type DetachDecision =
  | { kind: 'refuse'; reason: 'fullscreen' }
  | { kind: 'create-window'; position: Point; size: { width: number; height: number } }

export function decideDetach(ctx: DetachContext): DetachDecision {
  if (ctx.anyWindowFullscreen) {
    return { kind: 'refuse', reason: 'fullscreen' }
  }

  // Round the size first so position math uses the final integer dims.
  const width = Math.round(ctx.size.width)
  const height = Math.round(ctx.size.height)

  // Naive position: place the window so the cursor lands at the grab point.
  const rawX = Math.round(ctx.cursor.x - ctx.grabOffset.x)
  const rawY = Math.round(ctx.cursor.y - ctx.grabOffset.y)

  // Clamp so the window sits inside the display. If the window is wider than
  // the display, anchor at the display origin (the user can resize after).
  const maxX = ctx.displayBounds.x + Math.max(0, ctx.displayBounds.width - width)
  const maxY = ctx.displayBounds.y + Math.max(0, ctx.displayBounds.height - height)
  const x = Math.min(Math.max(rawX, ctx.displayBounds.x), maxX)
  const y = Math.min(Math.max(rawY, ctx.displayBounds.y), maxY)

  return { kind: 'create-window', position: { x, y }, size: { width, height } }
}

// -----------------------------------------------------------------------------
// Ghost window position
// -----------------------------------------------------------------------------

/** Clamp a desired ghost-window size to sane bounds; substitutes a default
 *  when the input is falsy (0 / NaN) so callers can always pass through
 *  `snapshot.geometry?.size?.width` without a guard. */
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
// Ghost-visibility decision — "should the native ghost window be hidden
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
