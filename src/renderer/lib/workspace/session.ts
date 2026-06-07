// =============================================================================
// Session persistence — save/restore workspace state as JSON.
// Ported from SessionSnapshot.swift + SessionStore.swift
// =============================================================================

import log from '../logger'
import {
  useAppStore,
  ensureCanvasOpsForPanel,
  getWorkspaceCanvasStore,
  getWorkspaceCanvasPanelId,
} from '../../stores/appStore'
import { setActivePanel } from '../activePanel'
import { getOrCreateWorkspaceDockStore } from './dockRegistry'
import {
  getWorkspaceDockSnapshot,
  getNodeDockLayout,
  getCanvasSnapshotForPanel,
  getWorkspaceCanvasPanelIds,
} from './canvasAccess'
import { deferredSnapshots, setDeferredRestoreHandler } from './deferredRestore'
import type { StoreApi } from 'zustand'
import { getOrCreateCanvasStoreForPanel } from '../../stores/canvasStore'
import type { CanvasStore } from '../../stores/canvasStore'
import type { DockStore } from '../../stores/dockStore'
import type {
  SessionSnapshot,
  MultiWorkspaceSession,
  PanelWindowSnapshot,
  DetachedDockWindowSnapshot,
  PanelType,
  ProjectWorkspaceFile,
  ProjectSessionFile,
  ProjectPanelRef,
  ProjectSessionPanel,
  PanelState,
  RemoteProjectEntry,
  DockWindowInitPayload,
  PanelTransferSnapshot,
  CanvasSnapshot,
  CanvasNodeState,
} from '../../../shared/types'
import { toRelativePath, toAbsolutePath } from '../../../shared/pathUtils'
import { isLocalLocator } from '../../../main/companion/locator'
import { deriveSidebarSession, applySidebarSession } from './sidebarSession'
import { terminalRegistry } from '../terminal/terminalRegistry'
import { mark } from '../perfMarks'

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
// Terminal restore data — populated during restoreSession(), consumed by
// terminalRegistry.getOrCreate() and replayTerminalLog(). The Map itself lives
// in the neutral lib/terminal/terminalRestoreData module so panelTransfer.ts can
// seed replay entries without importing this heavy module; re-exported here for
// back-compat with existing importers.
// -----------------------------------------------------------------------------

export { terminalRestoreData } from '../terminal/terminalRestoreData'
import { terminalRestoreData } from '../terminal/terminalRestoreData'

// Deferred snapshots for inactive workspaces — restored on first switch. The
// Map itself lives in the neutral lib/workspace/deferredRestore module (so
// appStore can read it without importing session, breaking the old cycle);
// re-exported here for existing importers.
export { deferredSnapshots }

// Last serialized session payload — used to skip disk writes when nothing
// actually changed, so the periodic auto-save doesn't rewrite an identical file
// every ~1s.
const lastSerializedByRoot = new Map<string, string>()
// Same idea for the global sidebar arrangement: skip the IPC + electron-store
// write when order/active-workspace haven't changed since the last save.
let lastSidebarSessionSerialized: string | null = null
// And for the remote-projects list (cate-companion:// restore snapshots).
let lastRemoteProjectsSerialized: string | null = null

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

// -----------------------------------------------------------------------------
// Project-local state builders (.cate/workspace.json + .cate/session.json)
// -----------------------------------------------------------------------------

export function buildWorkspaceFile(
  snapshot: SessionSnapshot,
  rootPath: string,
  color?: string,
): ProjectWorkspaceFile {
  // Shareable per-panel metadata, keyed by id. Machine-local facts (worktree
  // tag, working directory, unsaved scratch content) are excluded — they live in
  // session.json. Geometry lives in `canvases`.
  let panels: Record<string, ProjectPanelRef> | undefined
  if (snapshot.panels) {
    panels = {}
    for (const [id, p] of Object.entries(snapshot.panels)) {
      panels[id] = {
        type: p.type,
        title: p.title,
        filePath: p.filePath ? toRelativePath(p.filePath, rootPath) : undefined,
        url: p.url ?? undefined,
        proxyUrl: p.proxyUrl ?? undefined,
        documentType: p.documentType,
      }
    }
  }

  return {
    version: 1,
    name: snapshot.workspaceName,
    color: color ?? '',
    dockState: snapshot.dockState,
    panels,
    // Geometry for every canvas (primary + secondary), keyed by canvas panel id.
    canvases: snapshot.canvases,
  }
}

function buildSessionFile(
  snapshot: SessionSnapshot,
  panelWindows?: PanelWindowSnapshot[],
  dockWindows?: DetachedDockWindowSnapshot[],
): ProjectSessionFile {
  // Machine-local per-panel facts for every placed panel, keyed by id: the
  // worktree tag, the terminal's live working directory, and unsaved scratch
  // content — all kept out of the committed workspace.json.
  const panels: Record<string, ProjectSessionPanel> = {}
  for (const p of Object.values(snapshot.panels ?? {})) {
    const workingDirectory = snapshot.terminalCwds?.[p.id]
    if (!p.worktreeId && !workingDirectory && !p.unsavedContent) continue
    panels[p.id] = {
      panelId: p.id,
      workingDirectory,
      unsavedContent: p.unsavedContent,
      worktreeId: p.worktreeId,
    }
  }

  return {
    version: 1,
    workspaceId: snapshot.workspaceId,
    panels,
    panelWindows: panelWindows?.length ? panelWindows : undefined,
    dockWindows: dockWindows?.length ? dockWindows : undefined,
    // Worktree registry is machine-local (gitignored checkouts) — kept here, not
    // in the committed workspace.json. Paths are absolute, like workingDirectory.
    worktrees: snapshot.worktrees?.length ? snapshot.worktrees : undefined,
    // Machine-local reconnect info for a remote workspace (absent ⇒ local).
    connection: snapshot.connection,
  }
}

// -----------------------------------------------------------------------------
// Save
// -----------------------------------------------------------------------------

export async function saveSession(): Promise<void> {
  const updatedState = useAppStore.getState()

  const snapshots: SessionSnapshot[] = []

  // Skip ephemeral workspaces (no panels, no rootPath, and not deferred)
  const persistableWorkspaces = updatedState.workspaces.filter(
    (ws) => Object.keys(ws.panels).length > 0 || ws.rootPath || deferredSnapshots.has(ws.id),
  )

  for (const workspace of persistableWorkspaces) {
    // If this workspace has a deferred snapshot (never switched to), re-use
    // the original snapshot data instead of serializing the empty store state.
    const deferred = deferredSnapshots.get(workspace.id)
    if (deferred) {
      snapshots.push(deferred)
      continue
    }

    const isSelected = workspace.id === updatedState.selectedWorkspaceId

    // Dock layout from the workspace's OWN dock store if activated, else its
    // last-saved snapshot. The center-zone canvas panel is the primary canvas.
    const dockSnapshot = getWorkspaceDockSnapshot(workspace.id)

    // Geometry for EVERY canvas (primary + secondary alike), keyed by canvas
    // panel id. The live per-canvas store is the source of truth; each node's
    // mini-dock layout is refreshed on demand from the live per-node DockStore.
    // Every panel placed on a canvas (a node's seed + its tabbed children) is
    // collected so its record is persisted below.
    const canvasPanelIds = getWorkspaceCanvasPanelIds(workspace.id)
    let canvases: Record<string, CanvasSnapshot> | undefined
    const placedPanelIds = new Set<string>()
    for (const cpId of canvasPanelIds) {
      const snap = getCanvasSnapshotForPanel(cpId)
      if (!snap) continue
      const canvasNodes: Record<string, CanvasNodeState> = {}
      for (const [nodeId, node] of Object.entries(snap.nodes)) {
        const dockLayout = getNodeDockLayout(cpId, nodeId) ?? node.dockLayout ?? null
        canvasNodes[nodeId] = { ...node, dockLayout }
        if (node.panelId) placedPanelIds.add(node.panelId)
        const ids: string[] = []
        if (dockLayout) collectPanelIdsFromNode(dockLayout, ids)
        for (const id of ids) placedPanelIds.add(id)
      }
      ;(canvases ??= {})[cpId] = {
        id: cpId,
        canvasNodes,
        zoomLevel: snap.zoomLevel,
        viewportOffset: snap.viewportOffset,
      }
    }

    // Dock-zone panels (each canvas panel itself + docked terminals/agents/etc.).
    if (dockSnapshot) {
      for (const id of collectPanelIdsFromDockState(dockSnapshot.zones)) placedPanelIds.add(id)
    }

    // One record per placed panel + scrollback for every terminal, keyed by the
    // (restore-stable) panel id so replay finds it on the next launch.
    let panels: Record<string, PanelState> | undefined
    const scrollbackPromises: Promise<void>[] = []
    for (const id of placedPanelIds) {
      const panel = workspace.panels[id]
      if (!panel) continue
      ;(panels ??= {})[id] = panel
      if (panel.type === 'terminal') {
        const entry = terminalRegistry.getEntry(id)
        if (entry?.ptyId) {
          // Exclude the cursor row: scrollback is replayed into a freshly spawned
          // PTY on restore, which re-sends the prompt line.
          const content = terminalRegistry.captureScrollback(entry, { excludeCursorRow: true })
          if (content) {
            scrollbackPromises.push(
              window.electronAPI.terminalScrollbackSave(id, content).catch(() => {}),
            )
          }
        }
      }
    }
    if (scrollbackPromises.length > 0) {
      await Promise.all(scrollbackPromises)
    }

    // Live working directory for each terminal in the SELECTED workspace, keyed
    // by panel id, so a restored terminal respawns where it was. Batched.
    const terminalCwds: Record<string, string> = {}
    if (isSelected && panels) {
      const cwdPromises: { id: string; promise: Promise<string | null> }[] = []
      for (const panel of Object.values(panels)) {
        if (panel.type !== 'terminal') continue
        const entry = terminalRegistry.getEntry(panel.id)
        if (entry?.ptyId) {
          cwdPromises.push({
            id: panel.id,
            promise: window.electronAPI.terminalGetCwd(entry.ptyId).catch(() => null),
          })
        }
      }
      const results = await Promise.all(cwdPromises.map((p) => p.promise))
      for (let j = 0; j < cwdPromises.length; j++) {
        if (results[j]) terminalCwds[cwdPromises[j].id] = results[j] as string
      }
    }

    snapshots.push({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      rootPath: workspace.rootPath || null,
      dockState: dockSnapshot,
      panels,
      // Geometry for every canvas, keyed by canvas panel id (incl. the primary).
      canvases,
      terminalCwds: Object.keys(terminalCwds).length ? terminalCwds : undefined,
      // Persist the worktree registry (colors/labels) so they're stable across
      // restarts instead of re-assigned from the palette on rediscovery.
      worktrees: workspace.worktrees?.length ? workspace.worktrees : undefined,
      // Carry the remote reconnect info so it survives restart (Finding 2).
      connection: workspace.connection,
    })
  }

  // Capture detached window snapshots for inclusion in .cate/session.json
  let panelWindows: PanelWindowSnapshot[] | undefined
  try {
    const pwList = await window.electronAPI.panelWindowsList()
    if (pwList && pwList.length > 0) {
      panelWindows = pwList.map((pw) => ({
        panel: pw.panel,
        bounds: pw.bounds,
        workspaceId: pw.workspaceId,
        terminalPtyId: pw.terminalPtyId,
      }))
    }
  } catch (err) {
    log.warn('[session] Panel window listing failed:', err)
  }

  let dockWindows: DetachedDockWindowSnapshot[] | undefined
  try {
    const dwList = await window.electronAPI.dockWindowsList()
    if (dwList && dwList.length > 0) {
      dockWindows = dwList
    }
  } catch (err) {
    log.warn('[session] Dock window listing failed:', err)
  }

  // Remote (cate-companion://) workspaces can't use the local .cate/ files —
  // their tree lives on a companion. Collect their full snapshots + reconnect
  // info into the electron-store remoteProjects list so restart can rebuild and
  // reconnect them (Findings 2/3/4). TODO: route remote project-state through
  // companion.file so .cate/ lives next to the remote repo instead of here.
  const remoteEntries: RemoteProjectEntry[] = []
  for (const snapshot of snapshots) {
    if (!snapshot.rootPath || isLocalLocator(snapshot.rootPath)) continue
    if (!snapshot.connection || snapshot.connection.kind === 'local') continue
    remoteEntries.push({
      locator: snapshot.rootPath,
      connection: snapshot.connection,
      snapshot,
    })
  }
  const remoteSerialized = JSON.stringify(remoteEntries)
  if (remoteSerialized !== lastRemoteProjectsSerialized) {
    window.electronAPI.remoteProjectsSet(remoteEntries)
      .then(() => { lastRemoteProjectsSerialized = remoteSerialized })
      .catch((err) => {
        log.warn('[session] Remote projects save failed: %s', err)
      })
  }

  // Save to .cate/workspace.json + .cate/session.json per LOCAL workspace.
  const workspacesByRoot = new Map(
    persistableWorkspaces.filter((w) => w.rootPath).map((w) => [w.rootPath, w]),
  )
  for (const snapshot of snapshots) {
    if (!snapshot.rootPath) continue
    // Skip remote locators — guarded so projectStateSave never mangles a
    // cate-companion:// URI into a junk local .cate path (Finding 4).
    if (!isLocalLocator(snapshot.rootPath)) continue

    const ws = workspacesByRoot.get(snapshot.rootPath)
    const wsFile = buildWorkspaceFile(snapshot, snapshot.rootPath, ws?.color)

    // Filter detached windows belonging to this workspace
    const wsPanelWindows = panelWindows?.filter((pw) => pw.workspaceId === ws?.id)
    const wsDockWindows = dockWindows?.filter((dw) => (dw as any).workspaceId === ws?.id)
    const sessFile = buildSessionFile(snapshot, wsPanelWindows, wsDockWindows)

    // Dedup: skip IPC when the payload hasn't changed
    const serialized = JSON.stringify({ ws: wsFile, sess: sessFile })
    if (lastSerializedByRoot.get(snapshot.rootPath) === serialized) continue

    window.electronAPI.projectStateSave(snapshot.rootPath, wsFile, sessFile)
      .then(() => { lastSerializedByRoot.set(snapshot.rootPath!, serialized) })
      .catch((err) => {
        log.warn('[session] Project state save failed for %s: %s', snapshot.rootPath, err)
      })
  }

  // Persist the sidebar arrangement (order + active workspace, keyed by root
  // path) so a manual reorder and the active tab survive a restart. Triggered by
  // the same autosave that runs on reorder/select. recentProjects is left
  // recency-ordered for the Welcome page.
  const sidebarSession = deriveSidebarSession(updatedState.workspaces, updatedState.selectedWorkspaceId)
  const sidebarSerialized = JSON.stringify(sidebarSession)
  if (sidebarSerialized !== lastSidebarSessionSerialized) {
    await window.electronAPI.sidebarSessionSet(sidebarSession)
      .then(() => { lastSidebarSessionSerialized = sidebarSerialized })
      .catch((err) => {
        log.warn('[session] Sidebar session save failed: %s', err)
      })
  }
}

// -----------------------------------------------------------------------------
// Load
// -----------------------------------------------------------------------------

export async function loadSession(): Promise<MultiWorkspaceSession | null> {
  return loadFromProjectFiles()
}

/**
 * Convert an on-disk workspace.json (+ optional session.json) into the in-memory
 * SessionSnapshot used to rebuild a workspace. Shared by initial load and the
 * "Reload Workspace from Disk" command so the two paths can't drift.
 */
export function projectFilesToSnapshot(
  ws: ProjectWorkspaceFile,
  sess: ProjectSessionFile | null,
  rootPath: string,
): SessionSnapshot {
  // Recreate each panel record by id, merging the committed shareable metadata
  // with the machine-local session facts (worktree tag, unsaved scratch content).
  let panels: Record<string, PanelState> | undefined
  const terminalCwds: Record<string, string> = {}
  if (ws.panels) {
    panels = {}
    for (const [id, ref] of Object.entries(ws.panels)) {
      const sp = sess?.panels?.[id]
      panels[id] = {
        id,
        type: ref.type as PanelType,
        title: ref.title,
        isDirty: false,
        filePath: ref.filePath ? toAbsolutePath(ref.filePath, rootPath) : undefined,
        url: ref.url,
        proxyUrl: ref.proxyUrl,
        documentType: ref.documentType,
        // Re-attach the machine-local facts kept out of the committed file.
        worktreeId: sp?.worktreeId,
        unsavedContent: sp?.unsavedContent,
      }
      if (sp?.workingDirectory) terminalCwds[id] = sp.workingDirectory
    }
  }

  return {
    workspaceId: sess?.workspaceId,
    workspaceName: ws.name,
    rootPath,
    dockState: ws.dockState,
    panels,
    // Canvas geometry carries no file paths (only node geometry referencing panel
    // ids), so it passes through verbatim.
    canvases: ws.canvases,
    terminalCwds: Object.keys(terminalCwds).length ? terminalCwds : undefined,
    // Restore the persisted worktree registry (absolute paths) so colors/labels
    // are stable and panel.worktreeId references resolve after restart.
    worktrees: sess?.worktrees,
    // Restore the machine-local reconnect info (absent ⇒ local). Only the
    // local-disk path carries it here; remote workspaces come straight from the
    // remoteProjects store with their connection already on the snapshot.
    connection: sess?.connection,
  }
}

async function loadFromProjectFiles(): Promise<MultiWorkspaceSession | null> {
  let recentProjects: string[] = []
  try {
    recentProjects = (await window.electronAPI.recentProjectsGet()) ?? []
  } catch {
    recentProjects = []
  }

  // Remote (cate-companion://) workspaces never appear in recentProjects — they
  // live in the parallel remoteProjects store with their full restore snapshot
  // and reconnect info (Finding 3). Load them up front so they round-trip too.
  let remoteEntries: RemoteProjectEntry[] = []
  try {
    remoteEntries = (await window.electronAPI.remoteProjectsGet()) ?? []
  } catch {
    remoteEntries = []
  }

  if (recentProjects.length === 0 && remoteEntries.length === 0) return null

  const snapshots: SessionSnapshot[] = []
  const panelWindows: PanelWindowSnapshot[] = []
  const dockWindows: DetachedDockWindowSnapshot[] = []

  for (const rootPath of recentProjects) {
    // Defensive: a remote locator must never reach projectStateLoad (it would
    // mangle into a junk local path). Remote workspaces are loaded below.
    if (!isLocalLocator(rootPath)) continue
    try {
      const projectState = await window.electronAPI.projectStateLoad(rootPath) as {
        workspace: ProjectWorkspaceFile
        session: ProjectSessionFile | null
      } | null
      if (!projectState?.workspace) continue

      const ws = projectState.workspace
      const sess = projectState.session

      snapshots.push(projectFilesToSnapshot(ws, sess, rootPath))

      if (sess?.panelWindows) panelWindows.push(...sess.panelWindows)
      if (sess?.dockWindows) dockWindows.push(...sess.dockWindows)
    } catch (err) {
      log.warn('[session] Failed to load project state for %s: %s', rootPath, err)
    }
  }

  // Append remote workspaces. Their snapshot is self-contained (canvas layout +
  // connection), so no projectStateLoad is needed. Skip any whose connection
  // somehow went missing — without it ensureWorkspaceCompanion can't reconnect.
  for (const entry of remoteEntries) {
    if (!entry?.snapshot || !entry.connection || entry.connection.kind === 'local') continue
    const snap = entry.snapshot
    // Ensure the connection rides on the snapshot even for entries persisted
    // before connection was stored on the snapshot itself.
    snapshots.push({ ...snap, connection: snap.connection ?? entry.connection })
  }

  if (snapshots.length === 0) return null

  // Apply the persisted sidebar arrangement: reorder to the saved order and pick
  // the active workspace. Falls back to recentProjects order / index 0 when no
  // arrangement is stored yet (first run after upgrade).
  const sidebarSession = await window.electronAPI.sidebarSessionGet().catch(() => null)
  const { workspaces, selectedWorkspaceIndex } = applySidebarSession(snapshots, sidebarSession)

  return {
    version: 2,
    selectedWorkspaceIndex,
    workspaces,
    panelWindows: panelWindows.length > 0 ? panelWindows : undefined,
    dockWindows: dockWindows.length > 0 ? dockWindows : undefined,
  }
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
  // Remote workspaces have no local .cate/ layout — reading it would mangle the
  // cate-companion:// locator into a junk local path (Finding 4). Skip cleanly.
  // TODO: route remote reload through the companion file API.
  if (!isLocalLocator(ws.rootPath)) {
    log.info('[session] skip reload-from-disk for remote workspace %s', wsId)
    return
  }

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
  appStore.closeAllPanels(wsId)
  await restoreSession(snapshot, wsId)
  log.info('[session] reloaded workspace %s from disk (%d panels)', wsId, Object.keys(snapshot.panels ?? {}).length)
}

// -----------------------------------------------------------------------------
// Restore
// -----------------------------------------------------------------------------

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

  // Write scrollback content as plain text lines
  const lines = logData.split('\n')
  for (const line of lines) {
    entry.terminal.write(line + '\r\n')
  }
  // Dim separator between restored content and new session
  entry.terminal.write('\x1b[90m--- restored session ---\x1b[0m\r\n')

  terminalRestoreData.delete(panelId)
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
        // Remote workspace: do NOT block app startup on the companion connect.
        // selectWorkspace sets the selection + 'connecting' phase synchronously
        // (before its first await), so the sidebar shows this workspace
        // immediately. The handshake and panel restore run in the background.
        // restoreSession runs only AFTER selectWorkspace resolves (companion
        // live) so terminals/fs reads can't race an unregistered companion, and
        // it writes into this workspace's own stores by id.
        void appStore
          .selectWorkspace(wsId)
          .then(() => restoreSession(snapshot, wsId))
          .catch((error) => log.error('[session] background restore of remote workspace failed:', error))
      } else {
        // Local workspace: restore into its own stores FIRST (by id), then mark
        // it selected. Doing restore before select means selectWorkspace finds
        // the center canvas already present and won't mint a throwaway one.
        await restoreSession(snapshot, wsId)
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
  // Recreate panel windows that were open at the time of last save
  if (session.panelWindows && session.panelWindows.length > 0) {
    log.debug(`[session] restoring ${session.panelWindows.length} panel windows`)
    for (const pw of session.panelWindows) {
      try {
        const snapshot: import('../../../shared/types').PanelTransferSnapshot = {
          panel: pw.panel,
          geometry: {
            origin: { x: pw.bounds.x, y: pw.bounds.y },
            size: { width: pw.bounds.width, height: pw.bounds.height },
          },
          sourceLocation: { type: 'canvas', canvasId: '', canvasNodeId: '' },
          terminalReplayPtyId: pw.panel.type === 'terminal' ? pw.terminalPtyId : undefined,
          rootPath: useAppStore.getState().workspaces.find((w) => w.id === pw.workspaceId)?.rootPath || undefined,
        }
        // Pass the persisted workspaceId so the restored panel window is
        // registered to its workspace at creation — otherwise it is saved to no
        // workspace and lost on the next restart.
        const newWindowId = await window.electronAPI.panelTransfer(snapshot, undefined, pw.workspaceId)
        if (typeof newWindowId === 'number') {
          // Position the new panel window to its saved bounds
          // The main process createWindow positions it, but we passed geometry in the snapshot
          log.debug(`[session] panel window restored: ${pw.panel.title} (windowId=${newWindowId})`)
        }
      } catch (err) {
        log.warn(`[session] failed to restore panel window "${pw.panel.title}":`, err)
      }
    }
  }

  // Recreate dock windows that were open at the time of last save. Unlike a
  // LIVE single-panel detach (dragDetach + buildSinglePanelDockState), a restore
  // must rebuild the FULL window: every top-level tab from dw.dockState.zones,
  // each terminal tab's scrollback replay, and each canvas tab's children.
  if (session.dockWindows && session.dockWindows.length > 0) {
    log.debug(`[session] restoring ${session.dockWindows.length} dock windows`)
    for (const dw of session.dockWindows) {
      try {
        const init = buildDockWindowRestoreInit(dw)
        // A window with no top-level panels has nothing to show — skip it.
        if (init.topLevelPanelIds.length === 0) continue

        const rootPath = useAppStore.getState().workspaces.find((w) => w.id === dw.workspaceId)?.rootPath || undefined
        await window.electronAPI.dockWindowRestore({
          ...dw,
          initPayload: { ...init.initPayload, rootPath: rootPath ?? init.initPayload.rootPath },
        })
        log.debug(`[session] dock window restored: ${init.topLevelPanelIds.length} top-level tabs, ${Object.keys(dw.panels).length} panels`)
      } catch (err) {
        log.warn(`[session] failed to restore dock window:`, err)
      }
    }
  }

}

/**
 * Pure, testable reconstruction of a detached dock window from its persisted
 * snapshot. Returns the list of TOP-LEVEL panels (those referenced by the dock
 * zones — canvas CHILDREN live in dw.panels WITHOUT a zone reference) and a full
 * DockWindowInitPayload that restores the ORIGINAL zone/stack/tab layout with:
 *   • every top-level terminal tab seeded for scrollback replay
 *     (terminalReplayPtyIds[panelId] = dw.terminalPtyIds[panelId]), and
 *   • every top-level canvas tab's children hydrated via buildRestoredCanvasState
 *     (nodes + childPanels + childTerminals replay hints).
 * Back-compat: a snapshot without canvasStates degrades to empty canvases.
 */
export function buildDockWindowRestoreInit(
  dw: DetachedDockWindowSnapshot,
): { topLevelPanelIds: string[]; initPayload: DockWindowInitPayload } {
  const topLevelIds = collectPanelIdsFromDockState(dw.dockState.zones)
  const topLevelSet = new Set(topLevelIds)

  const terminalReplayPtyIds: Record<string, string> = {}
  const canvasStates: Record<string, PanelTransferSnapshot['canvasState']> = {}

  for (const panelId of topLevelIds) {
    const panel = dw.panels[panelId]
    if (!panel) continue
    if (panel.type === 'terminal') {
      const ptyId = dw.terminalPtyIds?.[panelId]
      if (ptyId) terminalReplayPtyIds[panelId] = ptyId
    } else if (panel.type === 'canvas') {
      const cs = buildRestoredCanvasState(dw, panel, topLevelSet)
      if (cs) canvasStates[panelId] = cs
    }
  }

  const initPayload: DockWindowInitPayload = {
    // Send EVERY persisted panel record (top-level tabs AND canvas children) so
    // the receiving shell can resolve types/titles for all of them.
    panels: dw.panels,
    dockState: dw.dockState.zones,
    workspaceId: dw.workspaceId,
    terminalReplayPtyIds: Object.keys(terminalReplayPtyIds).length ? terminalReplayPtyIds : undefined,
    canvasStates: Object.keys(canvasStates).length ? canvasStates : undefined,
  }

  return { topLevelPanelIds: topLevelIds, initPayload }
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

// -----------------------------------------------------------------------------
// Auto-save (idle debounce + max-wait + periodic unconditional save)
//
// Rationale: a pure trailing debounce never flushes during sustained activity
// (continuous canvas drag, typing into editor). We want background persistence
// with bounded data loss, without saving on every frame of a drag.
//
// - IDLE_DELAY: save this long after the last change (covers quiet periods)
// - MAX_WAIT:   guaranteed flush during sustained activity
// - PERIODIC_INTERVAL: unconditional periodic save to protect against crashes
// saveSession itself is async + IPC, so it doesn't block the render thread.
// -----------------------------------------------------------------------------

const IDLE_DELAY = 500
const MAX_WAIT = 4000
const PERIODIC_INTERVAL = 30_000

let idleTimer: ReturnType<typeof setTimeout> | null = null
let maxWaitTimer: ReturnType<typeof setTimeout> | null = null
let periodicTimer: ReturnType<typeof setInterval> | null = null

// Don't let a pending autosave timer keep a process alive on its own. In the
// browser/Electron renderer `setTimeout` returns a number (no `.unref`), so this
// is a no-op there and the timer behaves normally; under the Node test runner the
// handle is a Timeout object and unref'ing it lets vitest exit instead of hanging
// on the periodic-save interval. The timer still fires while the app is running.
function unrefTimer<T>(t: T): T {
  const h = t as unknown as { unref?: () => void }
  if (h && typeof h === 'object' && typeof h.unref === 'function') h.unref()
  return t
}
let pendingSave = false
let saveInFlight = false
let autoSaveSetUp = false
// "Dirty since last save" flag — set by every store subscription that schedules
// a save, cleared after a successful write. Lets the quit flush skip the IPC
// round-trip entirely when there's nothing to persist.
let sessionDirty = false
// Resolvers for flush requests waiting on an in-flight save to finish
let flushWaiters: (() => void)[] = []

function runSave(): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  if (maxWaitTimer) { clearTimeout(maxWaitTimer); maxWaitTimer = null }
  if (!pendingSave) return
  pendingSave = false
  if (saveInFlight) {
    // A save is already running; mark dirty so the next scheduler tick re-runs.
    pendingSave = true
    return
  }
  saveInFlight = true
  // Snapshot dirty at the moment the save begins; further mutations re-set it.
  sessionDirty = false
  saveSession()
    .catch(() => {
      // Save failed — re-mark dirty so the next flush still writes.
      sessionDirty = true
    })
    .finally(() => {
      saveInFlight = false
      // Notify any flush waiters that the save completed
      const waiters = flushWaiters
      flushWaiters = []
      for (const resolve of waiters) resolve()
      // If more changes arrived while saving, re-arm idle timer.
      if (pendingSave) scheduleSave()
    })
}

function scheduleSave(): void {
  pendingSave = true
  sessionDirty = true
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = unrefTimer(setTimeout(runSave, IDLE_DELAY))
  if (!maxWaitTimer) {
    maxWaitTimer = unrefTimer(setTimeout(runSave, MAX_WAIT))
  }
}

export function setupAutoSave(): () => void {
  if (autoSaveSetUp) {
    return () => {}
  }
  autoSaveSetUp = true

  // Each workspace owns its dock + canvas stores, so there is no single store to
  // subscribe to. Track the ACTIVE workspace's stores and re-subscribe whenever
  // the selection — or the resolved store instances — change. We re-evaluate on
  // every appStore change (selection switch, panel add/remove), which also
  // catches a canvas store being created lazily for the active workspace.
  let unsubActive: () => void = () => {}
  let curDock: StoreApi<DockStore> | null = null
  let curCanvas: StoreApi<CanvasStore> | null = null
  const subscribeActive = () => {
    const wsId = useAppStore.getState().selectedWorkspaceId || null
    const dock = wsId ? getOrCreateWorkspaceDockStore(wsId) : null
    const canvas = wsId ? getWorkspaceCanvasStore(wsId) : null
    if (dock === curDock && canvas === curCanvas) return
    curDock = dock
    curCanvas = canvas
    unsubActive()
    const subs: Array<() => void> = []
    if (dock) subs.push(dock.subscribe(scheduleSave))
    if (canvas) subs.push(canvas.subscribe(scheduleSave))
    unsubActive = () => { for (const u of subs) u() }
  }
  const unsubApp = useAppStore.subscribe(() => {
    subscribeActive()
    scheduleSave()
  })
  subscribeActive()

  // Unconditional periodic save — ensures on-disk state is never more than
  // PERIODIC_INTERVAL stale, even without detected store changes. Protects
  // against crashes, force-kills, and update restarts.
  periodicTimer = unrefTimer(setInterval(() => {
    if (pendingSave) {
      runSave()
    } else if (!saveInFlight) {
      // Force a save even without detected changes — workspace sync may have
      // drifted or external state (terminal CWD) changed without store updates.
      pendingSave = true
      runSave()
    }
  }, PERIODIC_INTERVAL))

  // Listen for flush-save requests from main process (quit, window close)
  const unsubFlush = window.electronAPI.onSessionFlushSave(() => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    if (maxWaitTimer) { clearTimeout(maxWaitTimer); maxWaitTimer = null }

    // Phase 4.3: skip the round-trip entirely when nothing has changed since
    // the last successful save. Cuts quit latency for read-only sessions.
    if (!sessionDirty && !pendingSave && !saveInFlight) {
      window.electronAPI.sessionFlushSaveDone()
      return
    }

    const doFlushSave = () => {
      saveInFlight = true
      pendingSave = false
      sessionDirty = false
      saveSession()
        .catch(() => { sessionDirty = true })
        .finally(() => {
          saveInFlight = false
          window.electronAPI.sessionFlushSaveDone()
        })
    }

    if (saveInFlight) {
      // A save is already in flight — wait for it to finish, then run a
      // fresh save with current state before sending the ACK.
      flushWaiters.push(doFlushSave)
    } else {
      doFlushSave()
    }
  })

  return () => {
    unsubActive()
    unsubApp()
    unsubFlush()
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    if (maxWaitTimer) { clearTimeout(maxWaitTimer); maxWaitTimer = null }
    if (periodicTimer) { clearInterval(periodicTimer); periodicTimer = null }
    autoSaveSetUp = false
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Build the `canvasState` for a detached canvas window being restored from a
 * `DetachedDockWindowSnapshot`. Pure (no store/IPC access) so it's unit-testable.
 *
 * Returns undefined when the top-level panel isn't a canvas (non-canvas dock
 * windows restore via terminalReplayPtyId only). When it IS a canvas:
 *   • nodes/viewport come from dw.canvasStates[canvasId] (empty if absent —
 *     old session files degrade gracefully to an empty canvas).
 *   • childPanels = every dw.panels entry that is NOT a top-level dock panel.
 *   • childTerminals = a `replayPtyId` restore hint per child terminal that has
 *     a persisted ptyId — the receiver spawns fresh + replays the dead PTY's log.
 */
export function buildRestoredCanvasState(
  dw: import('../../../shared/types').DetachedDockWindowSnapshot,
  topLevelPanel: import('../../../shared/types').PanelState,
  topLevelIds: Set<string>,
): import('../../../shared/types').PanelTransferSnapshot['canvasState'] | undefined {
  if (topLevelPanel.type !== 'canvas') return undefined

  const layout = dw.canvasStates?.[topLevelPanel.id]
  const childPanels: Record<string, import('../../../shared/types').PanelState> = {}
  const childTerminals: Record<string, { replayPtyId?: string }> = {}
  for (const [panelId, panel] of Object.entries(dw.panels)) {
    if (topLevelIds.has(panelId)) continue // top-level dock panels aren't canvas children
    childPanels[panelId] = panel
    if (panel.type === 'terminal') {
      const ptyId = dw.terminalPtyIds?.[panelId]
      if (ptyId) childTerminals[panelId] = { replayPtyId: ptyId }
    }
  }

  return {
    nodes: layout?.nodes ?? {},
    viewportOffset: layout?.viewportOffset ?? { x: 0, y: 0 },
    zoomLevel: layout?.zoomLevel ?? 1,
    childPanels,
    childTerminals,
  }
}

/** Collect all panel IDs referenced in a WindowDockState layout tree. */
function collectPanelIdsFromDockState(zones: import('../../../shared/types').WindowDockState): string[] {
  const ids: string[] = []
  for (const zone of Object.values(zones)) {
    if (zone.layout) collectPanelIdsFromNode(zone.layout, ids)
  }
  return ids
}

function collectPanelIdsFromNode(node: import('../../../shared/types').DockLayoutNode, ids: string[]): void {
  if (node.type === 'tabs') {
    ids.push(...node.panelIds)
  } else {
    for (const child of node.children) {
      collectPanelIdsFromNode(child, ids)
    }
  }
}

