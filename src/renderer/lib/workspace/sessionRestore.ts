// =============================================================================
// Session restore — the hub that rebuilds a single workspace from a snapshot,
// plus the deferred-restore handler, terminal scrollback replay, and the
// reload/hydrate-from-disk entry points. Registers the deferred-restore handler
// with the neutral injection slot at module load.
// =============================================================================

import log from '../logger'
import {
  useAppStore,
  ensureCanvasOpsForPanel,
  getWorkspaceCanvasPanelId,
} from '../../stores/appStore'
import { setActivePanel } from '../activePanel'
import { getOrCreateWorkspaceDockStore } from './dockRegistry'
import {
  getCanvasSnapshotForPanel,
  getWorkspaceCanvasPanelIds,
} from './canvasAccess'
import { getOrCreateCanvasStoreForPanel } from '../../stores/canvasStore'
import { deferredSnapshots, setDeferredRestoreHandler } from './deferredRestore'
import { terminalRestoreData } from '../terminal/terminalRestoreData'
import { terminalRegistry } from '../terminal/terminalRegistry'
import { collectPanelIdsFromDockState, projectFilesToSnapshot } from './sessionSerialize'
import { dockWindowsFromSession } from './sessionLoad'
import type {
  SessionSnapshot,
  ProjectWorkspaceFile,
  ProjectSessionFile,
} from '../../../shared/types'

/** Recreate every placed panel's record (dock-zone panels AND every canvas's
 *  child panels) into the workspace, preserving panel ids. The dock layout and
 *  canvas geometry below reference these by id; the panels themselves are
 *  instantiated lazily when their node/tab mounts. */
function restorePanelRecords(workspaceId: string, snapshot: SessionSnapshot): number {
  const appStore = useAppStore.getState()
  let restoredCount = 0

  if (!snapshot.panels) return 0

  for (const panel of Object.values(snapshot.panels)) {
    const existing = appStore.getWorkspace(workspaceId)?.panels[panel.id]
    if (!existing) {
      appStore.addPanel(workspaceId, panel)
      restoredCount += 1
    }
  }
  return restoredCount
}

function resolveSnapshotCanvasPanelId(snapshot: SessionSnapshot): string | null {
  if (snapshot.dockState) {
    const centerPanelIds = collectPanelIdsFromDockState({
      center: snapshot.dockState.zones.center,
      left: { position: 'left', visible: false, size: 0, layout: null },
      right: { position: 'right', visible: false, size: 0, layout: null },
      bottom: { position: 'bottom', visible: false, size: 0, layout: null },
    })
    for (const panelId of centerPanelIds) {
      if (!snapshot.panels || snapshot.panels[panelId]?.type === 'canvas') return panelId
    }

    const dockPanelIds = collectPanelIdsFromDockState(snapshot.dockState.zones)
    for (const panelId of dockPanelIds) {
      if (!snapshot.panels || snapshot.panels[panelId]?.type === 'canvas') return panelId
    }
  }

  const canvasPanel = Object.values(snapshot.panels ?? {}).find((panel) => panel.type === 'canvas')
  return canvasPanel?.id ?? null
}

/**
 * Re-read the active workspace's .cate/workspace.json from disk and rebuild the
 * canvas from it, discarding the current in-memory layout. This is how an
 * external edit to the file is applied without quitting the app — the autosave
 * guard in main keeps the edit from being clobbered until this runs.
 *
 * Tears down current panels (disposing terminals) then replays the on-disk
 * snapshot through the same restore path used at launch.
 */
export async function reloadActiveWorkspaceFromDisk(): Promise<void> {
  const appStore = useAppStore.getState()
  const wsId = appStore.selectedWorkspaceId
  const ws = appStore.workspaces.find((w) => w.id === wsId)
  if (!ws?.rootPath) return
  // projectStateLoad is locator-aware: a local rootPath reads local .cate/, a
  // remote cate-companion:// locator reads .cate/ on the companion next to the
  // remote repo. Both paths round-trip through the same restore below.

  const projectState = (await window.electronAPI.projectStateLoad(ws.rootPath)) as {
    workspace: ProjectWorkspaceFile
    session: ProjectSessionFile | null
  } | null
  if (!projectState?.workspace) return

  const snapshot = projectFilesToSnapshot(projectState.workspace, projectState.session, ws.rootPath)

  // Keep the workspace's display name/color in sync with the file.
  if (projectState.workspace.name) appStore.renameWorkspace(wsId, projectState.workspace.name)
  if (typeof projectState.workspace.color === 'string') {
    appStore.setWorkspaceColor(wsId, projectState.workspace.color)
  }

  // Discard the live layout, then rebuild from the file via the launch path.
  // remount bumps the reload epoch so the main shell remounts and respawns
  // terminals cleanly; detached windows are rebuilt afterwards.
  await restoreWorkspaceLayout(snapshot, wsId, { teardown: true, remount: true })
  // sessionStartup imports from this module, so break the cycle with a dynamic
  // import (matches the deferred-restore handler injection at module load).
  const { restoreWorkspaceDetachedWindows } = await import('./sessionStartup')
  await restoreWorkspaceDetachedWindows(
    wsId,
    dockWindowsFromSession(projectState.session),
    { closeExisting: true },
  )
  log.info('[session] reloaded workspace %s from disk (%d panels)', wsId, Object.keys(snapshot.panels ?? {}).length)
}

/**
 * True when a workspace has no meaningful layout yet: no panels at all, or only
 * canvas panels that hold zero nodes (the blank center canvas a fresh workspace
 * mints). Used to decide whether opening it should load the on-disk `.cate/`
 * layout, and whether a just-opened workspace still needs a starter terminal.
 */
export function isWorkspaceEffectivelyEmpty(wsId: string): boolean {
  const ws = useAppStore.getState().workspaces.find((w) => w.id === wsId)
  if (!ws) return true
  for (const panel of Object.values(ws.panels)) {
    if (panel.type !== 'canvas') return false
  }
  for (const cpId of getWorkspaceCanvasPanelIds(wsId)) {
    const snap = getCanvasSnapshotForPanel(cpId)
    if (snap && Object.keys(snap.nodes).length > 0) return false
  }
  return true
}

/**
 * Load a workspace's saved layout from its `.cate/` files when it's opened at
 * runtime with no live layout yet — the close-then-reopen path. Without this,
 * opening a workspace folder again (after closing it, or via a fresh
 * addWorkspace) comes up as a blank canvas because the layout is only read at
 * app startup, never on a runtime open.
 *
 * Locator-agnostic: a local rootPath reads local `.cate/`, a remote
 * cate-companion:// locator reads `.cate/` on the companion next to the remote
 * repo (projectStateLoad routes either way). For remote, the caller MUST ensure
 * the companion is connected first (restoreSession spawns terminals / reads
 * files through it).
 *
 * Guarded to be a safe no-op: it only acts when the workspace has a rootPath, no
 * live panels, and isn't owned by a pending deferred restore — so it never
 * clobbers an active layout and is idempotent across the several open paths that
 * call it.
 */
export async function hydrateWorkspaceFromDiskIfEmpty(wsId: string): Promise<void> {
  const appStore = useAppStore.getState()
  const ws = appStore.workspaces.find((w) => w.id === wsId)
  if (!ws?.rootPath) return
  // A deferred restore owns it, or it already has live content — leave it alone.
  // "Live content" means any non-canvas panel, or any canvas with nodes on it. A
  // freshly-opened workspace has only an empty center canvas (minted by
  // ensureCenterCanvas), which still counts as empty so the disk layout loads.
  if (deferredSnapshots.has(wsId)) return
  if (!isWorkspaceEffectivelyEmpty(wsId)) return

  const projectState = (await window.electronAPI.projectStateLoad(ws.rootPath)) as {
    workspace: ProjectWorkspaceFile
    session: ProjectSessionFile | null
  } | null
  if (!projectState?.workspace) return

  const snapshot = projectFilesToSnapshot(projectState.workspace, projectState.session, ws.rootPath)
  // Nothing worth restoring (no panels) — let the normal empty-canvas path run.
  if (!snapshot.panels || Object.keys(snapshot.panels).length === 0) return

  // Keep the workspace's display name/color in sync with the file.
  if (projectState.workspace.name) appStore.renameWorkspace(wsId, projectState.workspace.name)
  if (typeof projectState.workspace.color === 'string') {
    appStore.setWorkspaceColor(wsId, projectState.workspace.color)
  }

  await restoreWorkspaceLayout(snapshot, wsId, { teardown: true, remount: true })
  const { restoreWorkspaceDetachedWindows } = await import('./sessionStartup')
  await restoreWorkspaceDetachedWindows(
    wsId,
    dockWindowsFromSession(projectState.session),
    { closeExisting: true },
  )
  log.info('[session] hydrated workspace %s on open (%d panels)', wsId, Object.keys(snapshot.panels).length)
}

// -----------------------------------------------------------------------------
// Restore
// -----------------------------------------------------------------------------

/**
 * Unified workspace-layout restore. The single building block shared by the
 * three load paths (initial multi-workspace restore, reload-from-disk, and
 * hydrate-on-open) so they can't drift:
 *   • teardown — dispose the live layout first (closeAllPanels) before replaying.
 *   • remount — bump the reload epoch so the main shell remounts and respawns
 *     terminals cleanly (used by the from-disk rebuilds, not the launch path).
 */
export async function restoreWorkspaceLayout(
  snapshot: SessionSnapshot,
  wsId: string,
  opts: { teardown: boolean; remount: boolean },
): Promise<void> {
  if (opts.teardown) useAppStore.getState().closeAllPanels(wsId)
  await restoreSession(snapshot, wsId)
  if (opts.remount) useAppStore.getState().bumpReloadEpoch(wsId)
}

export async function restoreSession(snapshot: SessionSnapshot, workspaceId: string): Promise<void> {
  if (!snapshot) {
    log.warn('[session] invalid snapshot, skipping restore')
    return
  }

  // Restore strictly into the workspace identified by `workspaceId` and its own
  // stores — never the globally-selected workspace. This makes restore safe to
  // run for any workspace at any time (active or background), so a concurrent
  // switch can never redirect a restore into the wrong workspace.
  const appStore = useAppStore.getState()
  const wsId = workspaceId

  // Seed the worktree registry first, so the panels restored below can resolve
  // their persisted worktreeId, and so the colors/labels here win over anything
  // a background sync already discovered for the same checkout paths.
  if (snapshot.worktrees?.length) appStore.hydrateWorktrees(wsId, snapshot.worktrees)

  const restoredCount = restorePanelRecords(wsId, snapshot)
  if (restoredCount > 0) {
    log.debug(`[session] restored ${restoredCount} panel records for workspace ${wsId}`)
  }

  // Restore the dock layout into the workspace's OWN dock store up front, so the
  // center canvas resolves to the same panel the snapshot used.
  if (snapshot.dockState) {
    try {
      getOrCreateWorkspaceDockStore(wsId).getState().restoreSnapshot(snapshot.dockState)
      log.debug(`[session] dock state restored for workspace ${wsId}`)
    } catch (err) {
      log.warn('[session] failed to restore dock state:', err)
    }
  }

  const preferredCanvasPanelId = resolveSnapshotCanvasPanelId(snapshot) ?? getWorkspaceCanvasPanelId(wsId)
  if (preferredCanvasPanelId) {
    ensureCanvasOpsForPanel(preferredCanvasPanelId)
    setActivePanel(preferredCanvasPanelId)
  }

  const t0 = performance.now()

  // Seed EVERY canvas (primary + secondary alike) directly from its persisted
  // geometry, keeping the ORIGINAL panel ids — one path for all canvases, no
  // node-by-node re-minting. The panel records recreated above resolve each
  // node's panel by id; each node's mini-dock layout rides on the geometry and
  // is hydrated into the per-node DockStore when the node first mounts.
  if (snapshot.canvases) {
    for (const [cpId, canvas] of Object.entries(snapshot.canvases)) {
      getOrCreateCanvasStoreForPanel(cpId)
        .getState()
        .loadWorkspaceCanvas(canvas.canvasNodes, canvas.viewportOffset, canvas.zoomLevel)
    }
  }

  // Arm scrollback replay + respawn cwd for every terminal panel before its
  // TerminalPanel mounts. Scrollback is keyed by the (restore-stable) panel id.
  for (const panel of Object.values(snapshot.panels ?? {})) {
    if (panel.type !== 'terminal') continue
    if (terminalRestoreData.has(panel.id)) continue
    terminalRestoreData.set(panel.id, {
      cwd: snapshot.terminalCwds?.[panel.id],
      replayFromId: panel.id,
    })
  }

  // Safety net: guarantee the center zone has a canvas panel after restore.
  // Without this, a session saved in a bad state (or one whose center layout
  // references non-canvas panels only) would come up as a blank center pane.
  appStore.ensureCenterCanvas(wsId)

  log.debug(`[session] workspace ${wsId} restored in ${(performance.now() - t0).toFixed(1)}ms`)
}

// -----------------------------------------------------------------------------
// Replay terminal scrollback log
//
// Called by terminalRegistry after the PTY is fully wired and the xterm
// instance is live. Reads the persisted log for the original panel ID,
// writes it to the terminal, then clears the restore entry.
// -----------------------------------------------------------------------------

export async function replayTerminalLog(panelId: string): Promise<void> {
  const data = terminalRestoreData.get(panelId)
  if (!data?.replayFromId) return

  const logData = await window.electronAPI.terminalLogRead(data.replayFromId)
  if (!logData) {
    terminalRestoreData.delete(panelId)
    return
  }

  const entry = terminalRegistry.getEntry(panelId)
  if (!entry) {
    terminalRestoreData.delete(panelId)
    return
  }

  // logData is a SerializeAddon string (serializeTerminalState): escape sequences
  // that restore the saved buffer — text, styling, wrapping — verbatim. The fresh
  // shell's prompt then prints below the dim separator.
  entry.terminal.write(logData)
  entry.terminal.write('\r\n\x1b[90m--- restored session ---\x1b[0m\r\n')

  terminalRestoreData.delete(panelId)
}

// -----------------------------------------------------------------------------
// Restore a deferred workspace — called on first switch to an inactive workspace
// -----------------------------------------------------------------------------

export async function restoreDeferredWorkspace(workspaceId: string): Promise<void> {
  const snapshot = deferredSnapshots.get(workspaceId)
  if (!snapshot) return
  deferredSnapshots.delete(workspaceId)
  await restoreSession(snapshot, workspaceId)
}

// Register the real implementation with the neutral deferred-restore slot so
// appStore can trigger restore without importing session (cycle break).
setDeferredRestoreHandler(restoreDeferredWorkspace)
