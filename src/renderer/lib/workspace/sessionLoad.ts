import { migrateNavigationPanel } from '../../../shared/panels'
// =============================================================================
// Session load — read the on-disk project files (local + remote) and assemble a
// MultiWorkspaceSession for restore.
// =============================================================================

import { removedPanelIds, pruneDockState, pruneCanvasNodes } from '../../../shared/pruneRemovedPanels'
import log from '../logger'
import { isLocalLocator } from '../../../shared/runtimeLocator'
import { isRemoteRuntimeConnection } from '../../../shared/runtimeConnection'
import { applySidebarSession, dedupeSnapshotsByRoot } from './sidebarSession'
import { projectFilesToSnapshot } from './sessionSerialize'
import { ensureProjectTrusted } from '../../stores/workspaceTrustStore'
import type {
  SessionSnapshot,
  MultiWorkspaceSession,
  DetachedDockWindowSnapshot,
  ProjectWorkspaceFile,
  ProjectSessionFile,
  RemoteProjectEntry,
} from '../../../shared/types'

export async function loadSession(): Promise<MultiWorkspaceSession | null> {
  return loadFromProjectFiles()
}

export function dockWindowsFromSession(sess: ProjectSessionFile | null): DetachedDockWindowSnapshot[] {
  return (sess?.dockWindows ?? []).flatMap((window) => {
    const removed = removedPanelIds(window.panels)
    const panels = Object.fromEntries(Object.entries(window.panels).filter(([id]) => !removed.has(id)).map(([id, panel]) => [id, migrateNavigationPanel(panel)]))
    if (removed.size > 0 && !Object.keys(panels).length) return []
    return [{
      ...window,
      panels,
      dockState: pruneDockState(window.dockState, removed)!,
      canvasStates: Object.fromEntries(Object.entries(window.canvasStates ?? {}).map(([id, canvas]) => [id, {
        ...canvas, nodes: pruneCanvasNodes(canvas.nodes, removed),
      }])),
    }]
  })
}

/** Drop a declined project from the recents list. "Don't open" is also "stop
 *  asking" — otherwise every launch re-prompts for a project the user refused. */
async function forgetProject(rootPath: string): Promise<void> {
  log.info('[trust] %s declined at launch — not opening it, dropping from recents', rootPath)
  await window.electronAPI.recentProjectsRemove(rootPath).catch(() => { /* noop */ })
}

async function loadFromProjectFiles(): Promise<MultiWorkspaceSession | null> {
  let recentProjects: string[] = []
  try {
    recentProjects = (await window.electronAPI.recentProjectsGet()) ?? []
  } catch {
    recentProjects = []
  }

  // Remote reconnect metadata and the latest offline session cache are local;
  // startup can restore them before runtime transport is available.
  let remoteEntries: RemoteProjectEntry[] = []
  try {
    remoteEntries = (await window.electronAPI.remoteProjectsGet()) ?? []
  } catch {
    remoteEntries = []
  }

  if (recentProjects.length === 0 && remoteEntries.length === 0) return null

  const snapshots: SessionSnapshot[] = []
  const dockWindows: DetachedDockWindowSnapshot[] = []

  for (const rootPath of recentProjects) {
    // Remote workspaces restore from their offline cache below.
    if (!isLocalLocator(rootPath)) continue

    // Trust gate, BEFORE the project's files are read. Reopening at launch is
    // an open like any other, so an untrusted project is asked about rather
    // than restored. Under the current model this only comes up for projects
    // opened before trust existed, or after the user revoked it.
    if (!(await ensureProjectTrusted(rootPath))) {
      await forgetProject(rootPath)
      continue
    }

    try {
      const projectState = await window.electronAPI.projectStateLoad(rootPath) as {
        workspace: ProjectWorkspaceFile
        session: ProjectSessionFile | null
      } | null
      if (!projectState?.workspace) continue

      snapshots.push(projectFilesToSnapshot(projectState.workspace, projectState.session, rootPath))

      // Detached dock windows for this project.
      dockWindows.push(...dockWindowsFromSession(projectState.session))
    } catch (err) {
      log.warn('[session] Failed to load project state for %s: %s', rootPath, err)
    }
  }

  // Reconnect has not happened yet. Restore the latest machine-owned cache
  // through the same decoder as project files; retain legacy snapshot migration.
  const keptRemote: RemoteProjectEntry[] = []
  let declinedRemote = false
  for (const entry of remoteEntries) {
    if (!isRemoteRuntimeConnection(entry?.connection)) continue
    if (!(await ensureProjectTrusted(entry.locator))) {
      declinedRemote = true
      continue
    }
    keptRemote.push(entry)
    if (entry.cache?.version === 1) {
      const snapshot = projectFilesToSnapshot(entry.cache.workspace, entry.cache.session, entry.locator)
      snapshot.connection = entry.connection
      snapshots.push(snapshot)
      dockWindows.push(...dockWindowsFromSession(entry.cache.session))
    } else if (entry.snapshot) {
      snapshots.push({ ...entry.snapshot, connection: entry.connection })
    }
  }
  // "Don't open" is also "stop asking": drop the declined entries so the next
  // launch doesn't re-prompt for a project the user already refused.
  if (declinedRemote) {
    await window.electronAPI.remoteProjectsSet(keptRemote).catch(() => { /* noop */ })
  }

  if (snapshots.length === 0) return null

  // Apply the persisted sidebar arrangement: reorder to the saved order and pick
  // the active workspace. Falls back to recentProjects order / index 0 when no
  // arrangement is stored yet (first run after upgrade).
  const sidebarSession = await window.electronAPI.sidebarSessionGet().catch(() => null)
  const { workspaces, selectedWorkspaceIndex } = applySidebarSession(
    dedupeSnapshotsByRoot(snapshots),
    sidebarSession,
  )

  return {
    version: 2,
    selectedWorkspaceIndex,
    workspaces,
    dockWindows: dockWindows.length > 0 ? dockWindows : undefined,
  }
}
