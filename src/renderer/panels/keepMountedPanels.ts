// =============================================================================
// keepMountedPanels — which panel INSTANCES are exempt from the canvas viewport
// cull.
//
// Webview-backed panels (extensions) render a guest whose live state only exists
// in-page; unmounting destroys it unrecoverably, so they stay mounted when their
// canvas node scrolls off-screen. `keepsMountedOffscreen()` in shared/panels.ts
// answers this per panel TYPE; this module maps it over a workspace's panels and
// hands the cull a membership-stable Set.
//
// Only the geometric/viewport cull is affected. `keepsMountedWhenTabHidden()` is
// a separate question (a dock tab switch is a fast deliberate toggle).
// =============================================================================

import { useMemo } from 'react'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import type { PanelState } from '../../shared/types'
import { keepsMountedOffscreen } from '../../shared/panels'
import { useAppStore, type AppStore } from '../stores/appStore'

/** Panel ids that must stay mounted when their canvas node scrolls off-screen. */
export function keepMountedOffscreenPanelIds(
  panels: Record<string, PanelState> | undefined,
): Set<string> {
  const ids = new Set<string>()
  if (!panels) return ids
  for (const p of Object.values(panels)) {
    if (
      keepsMountedOffscreen(p.type) ||
      (p.codingAgentRun && !p.codingAgentRun.stoppedAt && !p.codingAgentRun.endedAt)
    ) {
      ids.add(p.id)
    }
  }
  return ids
}

// -----------------------------------------------------------------------------
// Hook
//
// The set below is handed to the cull's keep-alive cache, which is keyed on SET
// IDENTITY. The cull selector runs on every store update including every
// pan/zoom frame, so a set that is a fresh object each time would defeat the
// cache and re-walk every node's dock layout 60×/s. Hence the equality-checked
// selector: `setEqual` makes zustand hand back the SAME Set object whenever the
// membership is unchanged.
// -----------------------------------------------------------------------------

/** Same-membership equality, so the selector below returns a stable identity. */
export function setEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

/** The workspace's panel ids that are exempt from the viewport cull.
 *
 *  Pure panel-state churn (a title edit, dirty flag, …) re-runs the selector but
 *  produces an equal set, so the identity — and therefore the cull's keep-alive
 *  cache — survives. Panel `type` is immutable after creation, so the set only
 *  really changes when a keep-mounted panel is added or removed. The selector
 *  itself is memoized on its input so it isn't rebuilt on every render. */
export function useKeepMountedPanelIds(workspaceId: string): ReadonlySet<string> {
  const selector = useMemo(
    () => (s: AppStore) =>
      keepMountedOffscreenPanelIds(s.workspaces.find((w) => w.id === workspaceId)?.panels),
    [workspaceId],
  )
  return useStoreWithEqualityFn(useAppStore, selector, setEqual)
}
