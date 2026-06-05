// =============================================================================
// focusedDockPlacement — decide where a keyboard-created panel should land based
// on what the user is actually focused on, so a shortcut (Cmd+T / Cmd+Shift+E /
// Cmd+Shift+B) opens the panel next to them instead of always on the canvas.
// =============================================================================

import type { PanelPlacement } from '../stores/appStore'

/**
 * If focus is inside a dock zone (a docked panel — terminal, agent, editor,
 * etc.), return a placement targeting THAT zone so the new panel appears next to
 * the user. If focus is on a canvas, or anywhere that isn't a panel surface,
 * return undefined so creation falls back to the default canvas placement.
 *
 * A canvas is itself a tab inside the center dock zone, so we resolve the NEAREST
 * surface ancestor (grouped `closest`): focus on the canvas matches the canvas
 * container first and wins over its containing zone; focus in a sibling docked
 * panel matches the dock zone with no canvas in between. `[data-dock-zone]` is
 * only rendered by the window shells (never inside a canvas), so a canvas node
 * can never be mistaken for a dock zone.
 */
export function focusedDockPlacement(): PanelPlacement | undefined {
  const active = document.activeElement as HTMLElement | null
  const surface = active?.closest('[data-canvas-container],[data-dock-zone]') as HTMLElement | null
  if (!surface || surface.hasAttribute('data-canvas-container')) return undefined
  const zone = surface.getAttribute('data-dock-zone')
  if (zone === 'left' || zone === 'right' || zone === 'bottom' || zone === 'center') {
    return { target: 'dock', zone }
  }
  return undefined
}
