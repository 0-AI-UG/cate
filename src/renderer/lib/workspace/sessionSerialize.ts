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
import { collectPanelIds } from '../../../shared/collectPanelIds'
import { worktreeForPanel } from '../worktreeContext'

// -----------------------------------------------------------------------------
// Project-local state builders (.cate/workspace.json + .cate/session.json)
// -----------------------------------------------------------------------------

// Panel fields that persist verbatim (no path relativization) in BOTH
// directions between the in-memory PanelState and the on-disk ProjectPanelRef.
// `type`/`title` are always required and `filePath` needs explicit
// relative/absolute conversion, so they're handled separately. Enumerated ONCE
// here — consulted by both buildWorkspaceFile and projectFilesToSnapshot — so
// the two paths can't drift and silently drop a field on round-trip.
const PASSTHROUGH_PANEL_FIELDS = [
  'tabs',
  'activeTabId',
  'proxyUrl',
  'documentType',
  'extensionId',
  'extensionPanelId',
] as const

type PassthroughPanelFields = Pick<ProjectPanelRef, (typeof PASSTHROUGH_PANEL_FIELDS)[number]>

/** Copy the passthrough panel fields (see PASSTHROUGH_PANEL_FIELDS) from a
 *  PanelState or ProjectPanelRef, normalizing null → undefined. */
function pickPassthroughPanelFields(source: PassthroughPanelFields): PassthroughPanelFields {
  const out: Record<string, unknown> = {}
  for (const key of PASSTHROUGH_PANEL_FIELDS) out[key] = source[key] ?? undefined
  return out as PassthroughPanelFields
}

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
      const worktree = worktreeForPanel(p, snapshot.worktrees ?? [])
      const pathRoot = worktree?.path ?? rootPath
      panels[id] = {
        type: p.type,
        title: p.title,
        // File identity is repository-relative in the shareable file. The
        // machine-local session binding below decides which checkout restores it.
        filePath: p.filePath ? toRelativePath(p.filePath, pathRoot) : undefined,
        ...pickPassthroughPanelFields(p),
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
  // panel worktree tag, live working directory, and unsaved scratch
  // content — all kept out of the committed workspace.json.
  const panels: Record<string, ProjectSessionPanel> = {}
  for (const p of Object.values(snapshot.panels ?? {})) {
    const workingDirectory = snapshot.terminalCwds?.[p.id]
    const worktreeId = p.worktreeId ?? worktreeForPanel(p, snapshot.worktrees ?? [])?.id
    if (
      !worktreeId &&
      !workingDirectory &&
      !p.unsavedContent &&
      !p.agentSession &&
      !p.codingAgentRun &&
      !p.reviewState &&
      !p.agentThreadId
    ) continue
    panels[p.id] = {
      panelId: p.id,
      workingDirectory,
      unsavedContent: p.unsavedContent,
      worktreeId,
      agentSession: p.agentSession,
      codingAgentRun: p.codingAgentRun,
      reviewState: p.reviewState,
      agentThreadId: p.agentThreadId,
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
    worktreeViewScopes: snapshot.worktreeViewScopes,
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
      // Pre-T3 layouts used the old embedded-agent discriminator. Preserve the
      // panel placement while dropping all legacy embedded-chat state.
      const type = (ref.type === 'cateAgent' ? 'agent' : ref.type) as PanelType
      const pathRoot = sess?.worktrees?.find((worktree) => worktree.id === sp?.worktreeId)?.path ?? rootPath
      panels[id] = {
        id,
        type,
        title: ref.title,
        isDirty: false,
        filePath: ref.filePath ? toAbsolutePath(ref.filePath, pathRoot) : undefined,
        ...pickPassthroughPanelFields(ref),
        // Re-attach the machine-local facts kept out of the committed file.
        worktreeId: sp?.worktreeId,
        agentThreadId: type === 'agent' ? sp?.agentThreadId : undefined,
        unsavedContent: sp?.unsavedContent,
        // The agent session to resume in this terminal — TerminalPanel types
        // the resume command into the fresh shell and retains the stamp until
        // observed agent evidence replaces or clears it.
        agentSession: sp?.agentSession,
        codingAgentRun: sp?.codingAgentRun,
        reviewState: sp?.reviewState,
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
    worktreeViewScopes: sess?.worktreeViewScopes,
    // Restore the machine-local reconnect info (absent ⇒ local). Only the
    // local-disk path carries it here; remote workspaces come straight from the
    // remoteProjects store with their connection already on the snapshot.
    connection: sess?.connection,
  }
}

/** Collect all panel IDs referenced in a WindowDockState layout tree. */
export function collectPanelIdsFromDockState(zones: WindowDockState): string[] {
  const ids = new Set<string>()
  for (const zone of Object.values(zones)) {
    for (const id of collectPanelIds(zone.layout)) ids.add(id)
  }
  return [...ids]
}
