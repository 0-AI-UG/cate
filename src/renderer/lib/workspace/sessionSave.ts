// =============================================================================
// Session save — serialize every persistable workspace to .cate/workspace.json +
// .cate/session.json (and remote/sidebar stores), with per-target dedup so the
// periodic autosave doesn't rewrite identical files.
// =============================================================================

import log from '../logger'
import { useAppStore } from '../../stores/appStore'
import {
  getWorkspaceDockSnapshot,
  getWorkspaceCanvasPanelIds,
  captureCanvasPanel,
} from './canvasAccess'
import { captureAndSaveScrollback } from '../terminal/captureAndSaveScrollback'
import { deferredSnapshots } from './deferredRestore'
import { terminalRegistry } from '../terminal/terminalRegistry'
import { isLocalLocator } from '../../../shared/runtimeLocator'
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

// Last serialized session payload — used to skip disk writes when nothing
// actually changed, so the periodic auto-save doesn't rewrite an identical file
// every ~1s.
const lastSerializedByRoot = new Map<string, string>()
// Same idea for the global sidebar arrangement: skip the IPC + electron-store
// write when order/active-workspace haven't changed since the last save.
let lastSidebarSessionSerialized: string | null = null
// And for the remote-projects list (cate-runtime:// restore snapshots).
let lastRemoteProjectsSerialized: string | null = null

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
      ;(panels ??= {})[id] = panel
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

  // Capture detached dock-window snapshots for inclusion in .cate/session.json
  let dockWindows: DetachedDockWindowSnapshot[] | undefined
  try {
    const dwList = await window.electronAPI.dockWindowsList()
    if (dwList && dwList.length > 0) {
      dockWindows = dwList
    }
  } catch (err) {
    log.warn('[session] Dock window listing failed:', err)
  }

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

  // Remote (cate-runtime://) workspaces can't use the local .cate/ files —
  // their tree lives on a runtime. Collect their full snapshots + reconnect
  // info into the electron-store remoteProjects list so restart can rebuild and
  // reconnect them (Findings 2/3/4). TODO: route remote project-state through
  // runtime.file so .cate/ lives next to the remote repo instead of here.
  const remoteEntries: RemoteProjectEntry[] = []
  for (const snapshot of snapshots) {
    if (!snapshot.rootPath || isLocalLocator(snapshot.rootPath)) continue
    if (!isRemoteRuntimeConnection(snapshot.connection)) continue
    if (workspacesByRoot.get(snapshot.rootPath)?.id !== snapshot.workspaceId) continue
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

  // Save to .cate/workspace.json + .cate/session.json next to the repo for EVERY
  // workspace. Local writes to local disk; remote routes through the runtime to
  // the remote repo's .cate/ (projectStateSave is locator-aware). This is what
  // lets a closed remote workspace restore on reopen, exactly like local.
  for (const snapshot of snapshots) {
    if (!snapshot.rootPath) continue

    const ws = workspacesByRoot.get(snapshot.rootPath)
    // A single owner workspace per root writes its .cate/ files. Two workspaces
    // duplicated onto one rootPath would otherwise each write a different layout
    // every tick — the rootPath-keyed dedup never settles, .cate/workspace.json
    // flip-flops, and one layout is lost on restart. Skip the non-owner snapshot;
    // the owner (the selected one, else the first in order) wins.
    if (ws && ws.id !== snapshot.workspaceId) continue

    // NEVER write into an untrusted project. An open workspace is a trusted one
    // (the gate is on the open path), so this is an invariant check rather than
    // a filter — but it is what keeps a revoked-trust project from having its
    // `.cate/` files rewritten by a workspace that is still on screen.
    if (!isProjectTrusted(snapshot.rootPath)) continue

    const wsFile = buildWorkspaceFile(snapshot, snapshot.rootPath, ws?.color)

    // Filter detached dock windows belonging to this workspace
    const wsDockWindows = dockWindows?.filter((dw) => dw.workspaceId === ws?.id)
    const sessFile = buildSessionFile(snapshot, wsDockWindows)

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
