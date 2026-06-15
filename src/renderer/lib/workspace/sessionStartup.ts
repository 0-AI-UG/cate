// =============================================================================
// Session startup — multi-workspace restore at launch, detached-window restore,
// and the pure reconstruction helpers for detached dock windows.
// =============================================================================

import log from '../logger'
import { useAppStore } from '../../stores/appStore'
import { deferredSnapshots } from './deferredRestore'
import { collectPanelIdsFromDockState } from './sessionSerialize'
import { createDefaultDockState } from '../../stores/dockStore'
import { mark } from '../perfMarks'
import { restoreWorkspaceLayout } from './sessionRestore'
import type {
  MultiWorkspaceSession,
  PanelType,
  DetachedDockWindowSnapshot,
  DockWindowInitPayload,
  PanelTransferSnapshot,
  PanelState,
} from '../../../shared/types'

// ---------------------------------------------------------------------------
// Session-aware panel chunk prefetch — kicks off dynamic imports for only the
// panel types present in the session being restored. Fresh sessions prefetch
// the common defaults (terminal + editor + canvas).
// ---------------------------------------------------------------------------
function prefetchPanelChunks(types: ReadonlySet<PanelType>): void {
  if (types.has('terminal')) void import('../../panels/TerminalPanel')
  if (types.has('editor')) void import('../../panels/EditorPanel')
  if (types.has('browser')) void import('../../panels/BrowserPanel')
  if (types.has('canvas')) void import('../../panels/CanvasPanel')
}

// -----------------------------------------------------------------------------
// Restore — multi-workspace
// -----------------------------------------------------------------------------

export async function restoreMultiWorkspaceSession(session: MultiWorkspaceSession): Promise<void> {
  const appStore = useAppStore.getState()
  const tTotal = performance.now()
  log.debug(`[session] restoring multi-workspace session: ${session.workspaces.length} workspaces`)

  // Kick off dynamic imports for only the panel types this session uses, in
  // parallel with the restore work below. Terminal-only sessions skip Monaco.
  const presentTypes = new Set<PanelType>()
  for (const ws of session.workspaces) {
    for (const p of Object.values(ws.panels ?? {})) presentTypes.add(p.type as PanelType)
  }
  prefetchPanelChunks(presentTypes)

  // Clear any existing workspaces so we don't duplicate on every restart
  const existingIds = appStore.workspaces.map((w) => w.id)
  for (const id of existingIds) {
    appStore.removeWorkspace(id)
  }

  const selectedIdx = session.selectedWorkspaceIndex ?? 0

  // Create all workspaces (entries only) and only restore the active one's panels
  const wsIds: string[] = []
  for (let i = 0; i < session.workspaces.length; i++) {
    const snapshot = session.workspaces[i]
    log.debug(`[session] workspace ${i + 1}/${session.workspaces.length}: "${snapshot.workspaceName}" (${Object.keys(snapshot.panels ?? {}).length} panels)`)
    const wsId = appStore.addWorkspace(
      snapshot.workspaceName,
      snapshot.rootPath ?? undefined,
      snapshot.workspaceId,
      snapshot.connection,
    )
    wsIds.push(wsId)

    if (i === selectedIdx) {
      const isRemote = !!snapshot.connection && snapshot.connection.kind !== 'local'
      if (isRemote) {
        // Remote workspace: do NOT block app startup on the runtime connect.
        // selectWorkspace sets the selection + 'connecting' phase synchronously
        // (before its first await), so the sidebar shows this workspace
        // immediately. Defer the snapshot so selectWorkspace's deferred-restore
        // branch replays it AFTER the runtime is live (terminals/fs reads can't
        // race an unregistered runtime) — the same path non-selected workspaces
        // use, and it keeps the runtime hydrate-on-open hook from double-restoring.
        deferredSnapshots.set(wsId, snapshot)
        void appStore
          .selectWorkspace(wsId)
          .catch((error) => log.error('[session] background restore of remote workspace failed:', error))
      } else {
        // Local workspace: restore into its own stores FIRST (by id), then mark
        // it selected. Doing restore before select means selectWorkspace finds
        // the center canvas already present and won't mint a throwaway one. The
        // launch path neither tears down (nothing live yet) nor remounts.
        await restoreWorkspaceLayout(snapshot, wsId, { teardown: false, remount: false })
        await appStore.selectWorkspace(wsId)
      }
    } else {
      // Defer restoration — store the snapshot for lazy loading on first switch
      deferredSnapshots.set(wsId, snapshot)
    }
  }

  // Re-select the originally selected workspace (may be a no-op if already selected)
  if (selectedIdx < wsIds.length) {
    appStore.selectWorkspace(wsIds[selectedIdx])
  }

  log.debug(`[session] core session restored in ${(performance.now() - tTotal).toFixed(1)}ms`)
  mark('session-restored')
}

// -----------------------------------------------------------------------------
// Restore detached (panel + dock) windows — split out so the main window can
// paint before these (potentially slow) IPC calls run.
// -----------------------------------------------------------------------------

export async function restoreDetachedWindows(session: MultiWorkspaceSession): Promise<void> {
  // Recreate dock windows that were open at the time of last save. Detached
  // windows now restore ONLY via dock windows (legacy single-panel windows are
  // migrated into dock windows upstream, in dockWindowsFromSession). Unlike a
  // LIVE single-panel detach, a restore must rebuild the FULL window: every
  // top-level tab from dw.dockState.zones, each terminal tab's scrollback
  // replay, and each canvas tab's children.
  if (session.dockWindows && session.dockWindows.length > 0) {
    log.debug(`[session] restoring ${session.dockWindows.length} dock windows`)
    await recreateDockWindows(session.dockWindows)
  }
}

/**
 * Recreate a batch of detached dock windows, isolating each window's failure so
 * one bad snapshot can't abort the rest. When `workspaceIdOverride` is set, every
 * snapshot is rebound to that live workspace id before recreation (see the
 * reload/reopen rationale in restoreWorkspaceDetachedWindows).
 */
async function recreateDockWindows(
  dockWindows: DetachedDockWindowSnapshot[],
  workspaceIdOverride?: string,
): Promise<void> {
  for (const dw of dockWindows) {
    try {
      await recreateDockWindow(
        workspaceIdOverride === undefined ? dw : { ...dw, workspaceId: workspaceIdOverride },
      )
    } catch (err) {
      log.warn(`[session] failed to restore dock window:`, err)
    }
  }
}

/**
 * Restore a single workspace's detached dock windows on demand (reload /
 * hydrate-from-disk). When `closeExisting` is set, this workspace's currently
 * open detached windows are destroyed first so a rebuild doesn't duplicate them.
 * The caller passes only the dock windows that belong to `wsId`.
 */
export async function restoreWorkspaceDetachedWindows(
  wsId: string,
  dockWindows: DetachedDockWindowSnapshot[] | undefined,
  opts: { closeExisting: boolean },
): Promise<void> {
  if (opts.closeExisting) {
    await window.electronAPI.windowsCloseForWorkspace(wsId)
  }
  if (!dockWindows?.length) return
  // Rebind every snapshot to the live workspace id: a reopened workspace gets a
  // fresh runtime id, so the snapshot's saved dw.workspaceId is stale. For the
  // reload-from-disk case wsId already equals dw.workspaceId (no-op). This keeps
  // the rebuilt window's rootPath/worktrees resolvable and its workspace
  // association correct for the next save / close.
  await recreateDockWindows(dockWindows, wsId)
}

/** Recreate one detached dock window from its persisted snapshot, resolving the
 *  owning workspace's rootPath/worktrees and skipping windows that have no
 *  top-level panels. */
async function recreateDockWindow(dw: DetachedDockWindowSnapshot): Promise<void> {
  const init = buildDockWindowRestoreInit(dw)
  // A window with no top-level panels has nothing to show — skip it.
  if (init.topLevelPanelIds.length === 0) return

  const restoreWs = useAppStore.getState().workspaces.find((w) => w.id === dw.workspaceId)
  const rootPath = restoreWs?.rootPath || undefined
  await window.electronAPI.dockWindowRestore({
    ...dw,
    initPayload: {
      ...init.initPayload,
      rootPath: rootPath ?? init.initPayload.rootPath,
      worktrees: restoreWs?.worktrees ?? init.initPayload.worktrees,
    },
  })
  log.debug(`[session] dock window restored: ${init.topLevelPanelIds.length} top-level tabs, ${Object.keys(dw.panels).length} panels`)
}

/**
 * Pure, testable reconstruction of a detached dock window from its persisted
 * snapshot. Returns the list of TOP-LEVEL panels (those referenced by the dock
 * zones — canvas CHILDREN live in dw.panels WITHOUT a zone reference) and a full
 * DockWindowInitPayload that restores the ORIGINAL zone/stack/tab layout with:
 *   • `restore: true` + per-panel cwds, so the shell arms scrollback replay for
 *     EVERY terminal panel (top-level + canvas children) by its stable panelId —
 *     identical to the main window, no live-ptyId round-trip, and
 *   • every top-level canvas tab's layout hydrated via buildRestoredCanvasState
 *     (nodes + childPanels).
 * Back-compat: a snapshot without canvasStates degrades to empty canvases.
 */
export function buildDockWindowRestoreInit(
  dw: DetachedDockWindowSnapshot,
): { topLevelPanelIds: string[]; initPayload: DockWindowInitPayload } {
  // A legacy/malformed snapshot may lack dockState.zones entirely, or carry
  // zones that reference no panels. A window with no panels at all is genuinely
  // empty: return no top-level ids so the caller skips it. But when panel
  // records DO exist, dropping the window would silently lose them (the next
  // autosave only persists live windows) — recover by laying every panel out as
  // a tab in a fresh center stack instead.
  let zones = dw.dockState?.zones
  let topLevelIds = zones ? collectPanelIdsFromDockState(zones) : []
  if (topLevelIds.length === 0) {
    const orphanIds = Object.keys(dw.panels ?? {})
    if (orphanIds.length === 0) {
      return {
        topLevelPanelIds: [],
        initPayload: {
          panels: dw.panels,
          dockState: zones ?? createDefaultDockState(),
          workspaceId: dw.workspaceId,
          restore: true,
          terminalCwds: dw.terminalCwds,
        },
      }
    }
    log.warn(
      `[session] dock window snapshot has ${orphanIds.length} panels but no dock zones referencing them; recovering panels into a single tab stack`,
    )
    zones = createDefaultDockState()
    zones.center.layout = { type: 'tabs', id: 'restored-orphan-tabs', panelIds: orphanIds, activeIndex: 0 }
    topLevelIds = orphanIds
  }

  const topLevelSet = new Set(topLevelIds)

  const canvasStates: Record<string, PanelTransferSnapshot['canvasState']> = {}

  for (const panelId of topLevelIds) {
    const panel = dw.panels[panelId]
    if (!panel) continue
    if (panel.type === 'canvas') {
      const cs = buildRestoredCanvasState(dw, panel, topLevelSet)
      if (cs) canvasStates[panelId] = cs
    }
  }

  const initPayload: DockWindowInitPayload = {
    // Send EVERY persisted panel record (top-level tabs AND canvas children) so
    // the receiving shell can resolve types/titles AND arm replay for all of them.
    panels: dw.panels,
    // Past the guard above, zones is either the snapshot's own layout (with at
    // least one referenced panel) or the synthesized recovery stack.
    dockState: zones!,
    workspaceId: dw.workspaceId,
    // Cold restore: the shell replays every terminal panel by its panelId.
    restore: true,
    terminalCwds: dw.terminalCwds && Object.keys(dw.terminalCwds).length ? dw.terminalCwds : undefined,
    canvasStates: Object.keys(canvasStates).length ? canvasStates : undefined,
  }

  return { topLevelPanelIds: topLevelIds, initPayload }
}

/**
 * Build the `canvasState` for a detached canvas window being restored from a
 * `DetachedDockWindowSnapshot`. Pure (no store/IPC access) so it's unit-testable.
 *
 * Returns undefined when the top-level panel isn't a canvas. When it IS a canvas:
 *   • nodes/viewport come from dw.canvasStates[canvasId] (empty if absent —
 *     old session files degrade gracefully to an empty canvas).
 *   • childPanels = every dw.panels entry that is NOT a top-level dock panel.
 * Child terminal scrollback replay is NOT wired here: the shell arms replay for
 * EVERY terminal panel (children included) by its stable panelId on restore.
 */
export function buildRestoredCanvasState(
  dw: DetachedDockWindowSnapshot,
  topLevelPanel: PanelState,
  topLevelIds: Set<string>,
): PanelTransferSnapshot['canvasState'] | undefined {
  if (topLevelPanel.type !== 'canvas') return undefined

  const layout = dw.canvasStates?.[topLevelPanel.id]
  const childPanels: Record<string, PanelState> = {}
  for (const [panelId, panel] of Object.entries(dw.panels)) {
    if (topLevelIds.has(panelId)) continue // top-level dock panels aren't canvas children
    childPanels[panelId] = panel
  }

  return {
    nodes: layout?.nodes ?? {},
    viewportOffset: layout?.viewportOffset ?? { x: 0, y: 0 },
    zoomLevel: layout?.zoomLevel ?? 1,
    childPanels,
  }
}
