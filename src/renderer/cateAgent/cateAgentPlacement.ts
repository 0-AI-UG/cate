// =============================================================================
// cateAgentPlacement — pure grid math for where Cate Agent terminals go.
//
// Agent terminals get their own placement scheme, separate from the user-facing
// picker/auto-place in canvas/placement.ts: a fixed grid anchored BESIDE the
// user's content (never on top of it). One column per iteration, rows stacking
// down as a driver opens more terminals, so parallel iterations read left to
// right and one iteration's work + verify terminals read top to bottom. Pure
// functions (nodes in, points out) — the store wiring lives in
// cateAgentTerminals.
// =============================================================================

import type { CanvasNodeState, Point, Size } from '../../shared/types'
import { PLACEMENT_GAP } from '../canvas/placement'

/** Canvas-space gap between grid cells (the shared panel gap). */
export const AGENT_GRID_GAP = PLACEMENT_GAP
/** Canvas-space margin separating the agent area from the user's content. */
export const AGENT_AREA_MARGIN = 200

/** Grid cell for one agent terminal. `runKey` groups a run's terminals onto one
 *  shared anchor; column/row are the iteration's index and the terminal's index
 *  within that iteration. */
export interface AgentTerminalSlot {
  runKey: string
  column: number
  row: number
}

/** Top-left of a run's agent area: just right of everything already on the
 *  canvas, top-aligned with it. Empty canvas → centred on `viewCentre` so the
 *  first terminal appears in view. */
export function agentAreaAnchor(nodes: CanvasNodeState[], size: Size, viewCentre: Point): Point {
  if (nodes.length === 0) {
    return { x: viewCentre.x - size.width / 2, y: viewCentre.y - size.height / 2 }
  }
  const right = Math.max(...nodes.map((n) => n.origin.x + n.size.width))
  const top = Math.min(...nodes.map((n) => n.origin.y))
  return { x: right + AGENT_AREA_MARGIN, y: top }
}

/** Canvas-space origin of a slot's cell within the grid at `anchor`. */
export function agentGridPosition(anchor: Point, size: Size, slot: AgentTerminalSlot): Point {
  return {
    x: anchor.x + slot.column * (size.width + AGENT_GRID_GAP),
    y: anchor.y + slot.row * (size.height + AGENT_GRID_GAP),
  }
}
