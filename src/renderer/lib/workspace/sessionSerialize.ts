// =============================================================================
// Session serialize — pure inverses between in-memory SessionSnapshot and the
// on-disk project files (.cate/workspace.json + .cate/session.json), plus the
// shared dock-state panel-id collector. No store/IPC access.
// =============================================================================

import type {
  SessionSnapshot,
  DetachedDockWindowSnapshot,
  PanelType,
  ProjectWorkspaceFile,
  ProjectSessionFile,
  ProjectPanelRef,
  ProjectSessionPanel,
  PanelState,
  WindowDockState,
} from '../../../shared/types'
import { toRelativePath, toAbsolutePath } from '../../../shared/pathUtils'
import { collectPanelIds } from '../canvas/collectPanelIds'

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

export function buildSessionFile(
  snapshot: SessionSnapshot,
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
    dockWindows: dockWindows?.length ? dockWindows : undefined,
    // Worktree registry is machine-local (gitignored checkouts) — kept here, not
    // in the committed workspace.json. Paths are absolute, like workingDirectory.
    worktrees: snapshot.worktrees?.length ? snapshot.worktrees : undefined,
    // Machine-local reconnect info for a remote workspace (absent ⇒ local).
    connection: snapshot.connection,
  }
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
        // Restore the per-panel cwd (worktree path / dropped folder) so the
        // terminal respawns there. TerminalPanel reads panel.cwd directly. The
        // terminalCwds map below feeds the separate scrollback-restore path.
        cwd: sp?.workingDirectory,
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

/** Collect all panel IDs referenced in a WindowDockState layout tree. */
export function collectPanelIdsFromDockState(zones: WindowDockState): string[] {
  const ids: string[] = []
  for (const zone of Object.values(zones)) {
    for (const id of collectPanelIds(zone.layout)) ids.push(id)
  }
  return ids
}
