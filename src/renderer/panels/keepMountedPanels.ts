// =============================================================================
// keepMountedPanels — which panel INSTANCES are exempt from the canvas viewport
// cull.
//
// `keepsMountedOffscreen()` in shared/panels.ts answers this per panel TYPE, and
// it can't do better: it has no access to the extension registry. Extensions are
// the one type where the answer is per-instance:
//
//   • local extensions (frontend/server mode) render a guest whose live state
//     only exists in-page; unmounting destroys it unrecoverably → keep mounted.
//   • url-mode extensions (manifest.url, no server) point straight at a remote
//     SaaS SPA (Jira, Discord, …). Each one is a full Chromium renderer with
//     websockets and timers that would otherwise live forever once opened. Their
//     login lives in the persistent `persist:ext-<id>` partition, so a remount
//     reloads the page with the user still signed in → safe to cull.
//
// Only the geometric/viewport cull is affected. `keepsMountedWhenTabHidden()` is
// untouched: a dock tab switch is a fast deliberate toggle, and reloading a SaaS
// page on every tab switch would cost more than the memory it saves.
// =============================================================================

import { useEffect, useMemo } from 'react'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import type { ExtensionListEntry } from '../../shared/extensions'
import type { PanelState } from '../../shared/types'
import { keepsMountedOffscreen } from '../../shared/panels'
import { useAppStore, type AppStore } from '../stores/appStore'
import { useExtensionsStore, ensureExtensionsStarted } from '../stores/extensionsStore'

/** Extension ids that render a remote page rather than a locally served guest.
 *  Mode precedence is server > url > frontend (see getProxyUrlFor), so a
 *  manifest that declares both is NOT url mode. */
export function urlModeExtensionIds(entries: ExtensionListEntry[]): Set<string> {
  const ids = new Set<string>()
  for (const e of entries) {
    if (e.manifest.url && !e.manifest.server) ids.add(e.manifest.id)
  }
  return ids
}

/** Panel ids that must stay mounted when their canvas node scrolls off-screen.
 *
 *  `urlModeExtIds` is the set from {@link urlModeExtensionIds}. It is empty until
 *  the renderer's extension registry mirror loads, which is deliberately the safe
 *  direction: an unknown manifest keeps the panel mounted (the pre-existing
 *  behaviour), so a not-yet-loaded registry can never surprise-unmount a local
 *  extension. When the registry loads, the set legitimately changes once. */
export function keepMountedOffscreenPanelIds(
  panels: Record<string, PanelState> | undefined,
  urlModeExtIds: ReadonlySet<string>,
): Set<string> {
  const ids = new Set<string>()
  if (!panels) return ids
  for (const p of Object.values(panels)) {
    if (!keepsMountedOffscreen(p.type)) continue
    if (p.type === 'extension' && p.extensionId && urlModeExtIds.has(p.extensionId)) continue
    ids.add(p.id)
  }
  return ids
}

// -----------------------------------------------------------------------------
// Hooks
//
// Both sets below are handed to the cull's keep-alive cache, which is keyed on
// SET IDENTITY. The cull selector runs on every store update including every
// pan/zoom frame, so a set that is a fresh object each time would defeat the
// cache and re-walk every node's dock layout 60×/s. Hence the equality-checked
// selectors: `setEqual` makes zustand hand back the SAME Set object whenever the
// membership is unchanged.
// -----------------------------------------------------------------------------

/** Same-membership equality, so the selectors below return a stable identity. */
export function setEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

/** Extension ids that render a remote SaaS page instead of a locally served
 *  guest. The identity only changes when the registry's url-mode membership
 *  changes — in practice once, when the lazily started mirror first loads. */
export function useUrlModeExtensionIds(): ReadonlySet<string> {
  useEffect(() => { ensureExtensionsStarted() }, [])
  return useStoreWithEqualityFn(
    useExtensionsStore,
    (s) => urlModeExtensionIds(s.entries),
    setEqual,
  )
}

/** The workspace's panel ids that are exempt from the viewport cull.
 *
 *  Pure panel-state churn (a title edit, dirty flag, …) re-runs the selector but
 *  produces an equal set, so the identity — and therefore the cull's keep-alive
 *  cache — survives. Panel `type`/`extensionId` are immutable after creation, so
 *  the set only really changes when a keep-mounted panel is added or removed, or
 *  when the extension registry first loads. The selector itself is memoized on
 *  its inputs (both identity-stable) so it isn't rebuilt on every render. */
export function useKeepMountedPanelIds(workspaceId: string): ReadonlySet<string> {
  const urlModeExtIds = useUrlModeExtensionIds()
  const selector = useMemo(
    () => (s: AppStore) =>
      keepMountedOffscreenPanelIds(
        s.workspaces.find((w) => w.id === workspaceId)?.panels,
        urlModeExtIds,
      ),
    [workspaceId, urlModeExtIds],
  )
  return useStoreWithEqualityFn(useAppStore, selector, setEqual)
}
