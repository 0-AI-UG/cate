// =============================================================================
// activeSurface — tracks the surface the user is currently working in, so a
// keyboard-created panel (Cmd+T / Cmd+Shift+E / Cmd+Shift+B) opens where the
// user actually is instead of always on the canvas.
//
// Updated from real interaction events (pointer-down on a dock stack or on a
// canvas), NOT by querying document.activeElement at trigger time — so it stays
// correct even when focus isn't on a focusable element (e.g. the user clicked a
// tab but not into its content), and it can name the EXACT dock stack (which a
// zone alone can't, inside a split).
//
// Event ordering does the canvas-vs-dock disambiguation for free: a window-zone
// stack marks itself active on pointer-down CAPTURE, while a canvas marks itself
// on pointer-down BUBBLE. The canvas is rendered inside the center zone's stack,
// so clicking it fires the stack's capture first (dock) then the canvas's bubble
// (canvas) — canvas wins. Clicking a sibling docked panel in the split fires only
// the stack capture, so the dock stack wins. Canvas-node mini-docks are
// `localOnly` and never register here, so a node on the canvas stays "canvas".
// =============================================================================

import type { DockZonePosition } from '../../shared/types'
import type { PanelPlacement } from '../stores/appStore'

export type ActiveSurface =
  | { kind: 'canvas'; canvasPanelId: string }
  | { kind: 'dock'; zone: DockZonePosition; stackId: string }

let current: ActiveSurface | null = null

export function setActiveSurface(surface: ActiveSurface): void {
  current = surface
}

export function getActiveSurface(): ActiveSurface | null {
  return current
}

/** Forget the active dock stack if it's the one being removed, so a closed
 *  stack can't keep attracting newly-created panels. */
export function clearActiveDockStack(stackId: string): void {
  if (current?.kind === 'dock' && current.stackId === stackId) current = null
}

/**
 * Placement for a keyboard-created panel based on the active surface. A docked
 * stack → create as a tab in that exact stack (so splits land in the focused
 * pane, not the zone's first stack). Anything else (canvas, or no interaction
 * yet) → undefined, which keeps the existing default canvas placement.
 */
export function placementForActiveSurface(): PanelPlacement | undefined {
  if (current?.kind === 'dock') {
    return { target: 'dock', zone: current.zone, stackId: current.stackId }
  }
  return undefined
}
