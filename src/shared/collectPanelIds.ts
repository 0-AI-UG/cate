// =============================================================================
// collectPanelIds — the single DockLayout tree walk that gathers every panelId
// inside a layout. Every dock-aware site (canvas close, detach cleanup, the
// workspace panel tree, session capture, and the main-process window registry)
// consumes this instead of hand-rolling the same recursion.
//
// Lives in shared/ because both the renderer and the main process (deriving a
// detached canvas's children from a synced layout) need it. Returns the
// collected ids as an array. Pass an optional `into` Set to also accumulate into
// a caller-owned sink (the returned array still holds only the ids found in THIS
// layout). Null/undefined layouts collect nothing.
// =============================================================================

import type { DockLayoutNode } from './types'

export function collectPanelIds(
  layout: DockLayoutNode | null | undefined,
  into?: Set<string>,
): string[] {
  const out: string[] = []
  walk(layout, out, into)
  return out
}

/** The visible panel in the first leaf of a dock tree. */
export function activeDockPanelId(layout: DockLayoutNode | null | undefined): string | null {
  if (!layout) return null
  if (layout.type === 'tabs') {
    return layout.panelIds[layout.activeIndex] ?? layout.panelIds[0] ?? null
  }
  for (const child of layout.children) {
    const panelId = activeDockPanelId(child)
    if (panelId) return panelId
  }
  return null
}

function walk(
  layout: DockLayoutNode | null | undefined,
  out: string[],
  into: Set<string> | undefined,
): void {
  if (!layout) return
  if (layout.type === 'tabs') {
    for (const id of layout.panelIds) {
      out.push(id)
      into?.add(id)
    }
    return
  }
  for (const child of layout.children) walk(child, out, into)
}
