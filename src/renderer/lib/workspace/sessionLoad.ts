// =============================================================================
// Session load — read the on-disk project files (local + remote) and assemble a
// MultiWorkspaceSession for restore.
// =============================================================================

import log from '../logger'
import { isLocalLocator } from '../../../main/runtime/locator'
import { applySidebarSession } from './sidebarSession'
import { projectFilesToSnapshot } from './sessionSerialize'
import { createDefaultDockState } from '../../stores/dockStore'
import { generateId } from '../../stores/canvas/helpers'
import type {
  SessionSnapshot,
  MultiWorkspaceSession,
  PanelWindowSnapshot,
  DetachedDockWindowSnapshot,
  ProjectWorkspaceFile,
  ProjectSessionFile,
  RemoteProjectEntry,
} from '../../../shared/types'

export async function loadSession(): Promise<MultiWorkspaceSession | null> {
  return loadFromProjectFiles()
}

/**
 * Convert legacy single-panel `panelWindows` (removed) into the dock-window
 * shape so old session files still restore their detached panels. Each legacy
 * window becomes a one-tab dock window: a single visible center zone holding the
 * panel, all side zones hidden.
 */
function migrateLegacyPanelWindows(sess: ProjectSessionFile | null): DetachedDockWindowSnapshot[] {
  const legacy = (sess as (ProjectSessionFile & { panelWindows?: PanelWindowSnapshot[] }) | null)?.panelWindows
  if (!legacy?.length) return []
  const out: DetachedDockWindowSnapshot[] = []
  for (const pw of legacy) {
    const zones = createDefaultDockState()
    zones.center.layout = { type: 'tabs', id: generateId(), panelIds: [pw.panel.id], activeIndex: 0 }
    out.push({
      dockState: { zones, locations: {} },
      panels: { [pw.panel.id]: pw.panel },
      bounds: pw.bounds,
      workspaceId: pw.workspaceId ?? '',
    })
  }
  return out
}

/** All detached dock windows for a session file: the persisted dockWindows plus
 *  any migrated from legacy panelWindows. */
export function dockWindowsFromSession(sess: ProjectSessionFile | null): DetachedDockWindowSnapshot[] {
  return [...(sess?.dockWindows ?? []), ...migrateLegacyPanelWindows(sess)]
}

async function loadFromProjectFiles(): Promise<MultiWorkspaceSession | null> {
  let recentProjects: string[] = []
  try {
    recentProjects = (await window.electronAPI.recentProjectsGet()) ?? []
  } catch {
    recentProjects = []
  }

  // Remote (cate-runtime://) workspaces never appear in recentProjects — they
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

      // Detached dock windows for this project (including any migrated from the
      // legacy panelWindows shape).
      dockWindows.push(...dockWindowsFromSession(sess))
    } catch (err) {
      log.warn('[session] Failed to load project state for %s: %s', rootPath, err)
    }
  }

  // Append remote workspaces. Their snapshot is self-contained (canvas layout +
  // connection), so no projectStateLoad is needed. Skip any whose connection
  // somehow went missing — without it ensureWorkspaceRuntime can't reconnect.
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
    dockWindows: dockWindows.length > 0 ? dockWindows : undefined,
  }
}
