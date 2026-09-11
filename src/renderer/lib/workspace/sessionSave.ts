import { gitStatusStore } from '../../stores/gitStatusStore'
import { notifySessionMutation } from './sessionMutations'
import { KeyedLock } from '../../../shared/keyedLock'
import { captureEditorPanel } from '../editor/editorDocuments'
// =============================================================================
// Session save — serialize every persistable workspace to .cate/workspace.json +
// .cate/session.json (and remote/sidebar stores), with per-target dedup so the
// periodic autosave doesn't rewrite identical files.
// =============================================================================

import { useAppStore } from '../../stores/appStore'
import { useUIStore } from '../../stores/uiStore'
import {
  getWorkspaceDockSnapshot,
  getWorkspaceCanvasPanelIds,
  captureCanvasPanel,
} from './canvasAccess'
import { captureAndSaveScrollback } from '../terminal/captureAndSaveScrollback'
import { deferredSnapshots } from './deferredRestore'
import { terminalRegistry } from '../terminal/terminalRegistry'
import { isLocalLocator, parseLocator } from '../../../shared/runtimeLocator'
import { isRemoteRuntimeConnection } from '../../../shared/runtimeConnection'
import { deriveSidebarSession } from './sidebarSession'
import { isProjectTrusted } from '../../stores/workspaceTrustStore'
import { buildWorkspaceFile, buildSessionFile, collectPanelIdsFromDockState } from './sessionSerialize'
import type {
  SessionSnapshot,
  DetachedDockWindowSnapshot,
  PanelState,
  RemoteProjectEntry,
  CanvasSnapshot,
} from '../../../shared/types'
import { pathKey } from '../../../shared/pathUtils'

// Last serialized session payload — used to skip disk writes when nothing
// actually changed, so the periodic auto-save doesn't rewrite an identical file
// every ~1s.
const lastSerializedByRoot = new Map<string, string>()
const saveQueue = new KeyedLock()
// Same idea for the global sidebar arrangement: skip the IPC + JSON-file
// write when order/active-workspace haven't changed since the last save.
let lastSidebarSessionSerialized: string | null = null
// And for the remote-projects list (cate-runtime:// restore snapshots).
let lastRemoteProjectsSerialized: string | null = null

/** Dismiss a disk conflict and publish the unchanged current layout again. */
export async function keepWorkspaceLayout(rootPath: string): Promise<void> {
  await window.electronAPI.dismissWorkspaceExternalEdit(rootPath)
  lastSerializedByRoot.delete(rootPath)
  notifySessionMutation()
  await saveSession()
}

export function saveSession(): Promise<void> {
  return saveQueue.run('session', persistSession)
}

async function persistSession(): Promise<void> {
  const updatedState = useAppStore.getState()
  const uiState = useUIStore.getState()

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
      const snap = captureCanvasPanel(cpId)
      for (const panelId of snap.panelIds) placedPanelIds.add(panelId)
      ;(canvases ??= {})[cpId] = {
        id: cpId,
        canvasNodes: snap.nodes,
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
      ;(panels ??= {})[id] = captureEditorPanel(panel)
      if (panel.type === 'terminal') {
        const entry = terminalRegistry.getEntry(id)
        if (entry?.ptyId) {
          // Key scrollback by the (restore-stable) panel id so replay finds it
          // on the next launch.
          const promise = captureAndSaveScrollback(entry, id)
          if (promise) scrollbackPromises.push(promise)
        }
      }
    }
    if (scrollbackPromises.length > 0) {
      await Promise.all(scrollbackPromises)
    }

    // Live working directory for every running terminal, keyed by panel id, so a
    // restored terminal respawns where it was. Batched. PTYs keep running in
    // non-selected (but previously activated) workspaces, so capture is NOT
    // limited to the selected one; never-activated workspaces took the deferred-
    // snapshot path above and keep their saved cwds.
    const terminalCwds: Record<string, string> = {}
    if (panels) {
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

    const repositoryRoots = [workspace.rootPath, ...(workspace.additionalRoots ?? []),
      ...(workspace.worktrees ?? []).map(worktree => worktree.path),
      ...gitStatusStore.getSnapshot(workspace.rootPath).worktrees.map(worktree => worktree.path),
    ].filter(Boolean).map(root => parseLocator(root))
    const belongsToWorkspace = ([repositoryRoot]: [string, string]) => {
      const repository = parseLocator(repositoryRoot)
      return repositoryRoots.some(root => repository.runtimeId === root.runtimeId &&
        (pathKey(repository.path) === pathKey(root.path) || pathKey(repository.path).startsWith(`${pathKey(root.path)}/`)))
    }
    const sourceControlWorktreeByRepository = Object.fromEntries(Object.entries(uiState.sourceControlWorktreeByRepository).filter(belongsToWorkspace))
    const sourceControlDrafts = Object.fromEntries(Object.entries(uiState.sourceControlDrafts ?? {}).filter(belongsToWorkspace))
    const hasWorktreeViewScopes = Object.keys(sourceControlWorktreeByRepository).length > 0 || Object.keys(sourceControlDrafts).length > 0

    snapshots.push({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      rootPath: workspace.rootPath || null,
      dockState: dockSnapshot,
      panels,
      panelRelations: workspace.panelRelations?.length ? workspace.panelRelations : undefined,
      // Geometry for every canvas, keyed by canvas panel id (incl. the primary).
      canvases,
      terminalCwds: Object.keys(terminalCwds).length ? terminalCwds : undefined,
      // Persist the worktree registry (colors/labels) so they're stable across
      // restarts instead of re-assigned from the palette on rediscovery.
      worktrees: workspace.worktrees?.length ? workspace.worktrees : undefined,
      worktreeViewScopes: hasWorktreeViewScopes ? {
        sourceControlDrafts,
        sourceControlWorktreeByRepository: Object.keys(sourceControlWorktreeByRepository).length
          ? sourceControlWorktreeByRepository
          : undefined,
      } : undefined,
      // Carry the remote reconnect info so it survives restart (Finding 2).
      connection: workspace.connection,
    })
  }

  // Capture detached dock-window snapshots for inclusion in .cate/session.json
  // An unavailable owner listing cannot safely be interpreted as no windows.
  const dockWindows: DetachedDockWindowSnapshot[] | undefined = await window.electronAPI.dockWindowsList()

  // One owner workspace per root. Legacy state may still contain duplicates;
  // the selected workspace owns persistence, otherwise the first one does.
  const workspacesByRoot = new Map<string, typeof persistableWorkspaces[number]>()
  for (const w of persistableWorkspaces) {
    if (!w.rootPath) continue
    const existing = workspacesByRoot.get(w.rootPath)
    if (!existing || w.id === updatedState.selectedWorkspaceId) {
      workspacesByRoot.set(w.rootPath, w)
    }
  }

  // Use one serialized representation for local files, remote files and offline
  // recovery. The local cache is the latest session owned by this machine; it
  // restores before a remote runtime reconnects. Runtime files support explicit
  // project reopen. Never derive a second, incomplete remote-only snapshot.
  const payloads = snapshots.flatMap(snapshot => {
    if (!snapshot.rootPath) return []
    const owner = workspacesByRoot.get(snapshot.rootPath)
    if (owner && owner.id !== snapshot.workspaceId) return []
    const workspace = buildWorkspaceFile(snapshot, snapshot.rootPath, owner?.color)
    const session = buildSessionFile(snapshot, dockWindows?.filter(dw => dw.workspaceId === owner?.id))
    return [{ snapshot, owner, workspace, session }]
  })
  const remoteEntries: RemoteProjectEntry[] = payloads.flatMap(({ snapshot, workspace, session }) => {
    if (isLocalLocator(snapshot.rootPath!) || !isRemoteRuntimeConnection(snapshot.connection)) return []
    return [{ locator: snapshot.rootPath!, connection: snapshot.connection, cache: { version: 1 as const, workspace, session } }]
  })
  const errors: unknown[] = []
  const remoteSerialized = JSON.stringify(remoteEntries)
  if (remoteSerialized !== lastRemoteProjectsSerialized) {
    try {
      await window.electronAPI.remoteProjectsSet(remoteEntries)
      lastRemoteProjectsSerialized = remoteSerialized
    } catch (error) { errors.push(error) }
  }

  // Save to .cate/workspace.json + .cate/session.json next to the repo for EVERY
  // workspace. Local writes to local disk; remote routes through the runtime to
  // the remote repo's .cate/ (projectStateSave is locator-aware). This is what
  // lets a closed remote workspace restore on reopen, exactly like local.
  for (const { snapshot, owner: ws, workspace: wsFile, session: sessFile } of payloads) {
    if (!snapshot.rootPath || !isProjectTrusted(snapshot.rootPath)) continue

    // Dedup: skip IPC when the payload hasn't changed
    const allowEmptyLayout = ws?.layoutRootPath === snapshot.rootPath && !deferredSnapshots.has(ws.id)
    const serialized = JSON.stringify({ ws: wsFile, sess: sessFile, allowEmptyLayout })
    if (lastSerializedByRoot.get(snapshot.rootPath) === serialized) continue
    try {
      await window.electronAPI.projectStateSave(snapshot.rootPath, wsFile, sessFile, ws?.id, { allowEmptyLayout })
      lastSerializedByRoot.set(snapshot.rootPath, serialized)
    } catch (error) { errors.push(error) }
  }

  // Persist the sidebar arrangement (order + active workspace, keyed by root
  // path) so a manual reorder and the active tab survive a restart. Triggered by
  // the same autosave that runs on reorder/select. recentProjects is left
  // recency-ordered for the Welcome page.
  const sidebarSession = deriveSidebarSession(updatedState.workspaces, updatedState.selectedWorkspaceId)
  const sidebarSerialized = JSON.stringify(sidebarSession)
  if (sidebarSerialized !== lastSidebarSessionSerialized) {
    try {
      await window.electronAPI.sidebarSessionSet(sidebarSession)
      lastSidebarSessionSerialized = sidebarSerialized
    } catch (error) { errors.push(error) }
  }
  if (errors.length) throw errors[0]
}
