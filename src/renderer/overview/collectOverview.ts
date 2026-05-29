// =============================================================================
// collectOverview — flattens every workspace into a uniform list of "windows"
// for the global Overview overlay.
//
// Two data sources have to be unioned because inactive workspaces are NOT fully
// hydrated in memory:
//   1. Visited / active workspaces — `ws.canvasNodes` (geometry + stable node
//      ids) joined against `ws.panels` (type/title/filePath/url/cwd).
//   2. Deferred workspaces (never switched to this session) — `ws.canvasNodes`
//      is empty; the data lives in the lazy `deferredSnapshots` map as
//      `NodeSnapshot[]`, which already carries type/title/filePath/url/
//      workingDirectory directly (no panel join).
//
// Node/panel ids are regenerated when a deferred workspace is restored, so a
// snapshot node has no id that survives the round-trip. Therefore `nodeId` is
// populated only for visited workspaces; deferred windows navigate to the
// workspace without focusing a specific node.
// =============================================================================

import { useAppStore } from '../stores/appStore'
import { useStatusStore } from '../stores/statusStore'
import { selectAgentInfoByPanel } from '../hooks/useAgentPanelInfo'
import { getAgentLogo } from '../lib/agentLogos'
import { deferredSnapshots } from '../lib/session'
import type { PanelType, PanelState, NodeSnapshot, CanvasNodeState } from '../../shared/types'

export interface OverviewWindow {
  workspaceId: string
  panelId: string
  /** Stable canvas-node id — only known for visited workspaces (null otherwise). */
  nodeId: string | null
  panelType: PanelType
  title: string
  /** Short secondary line: editor→file, terminal→cwd, browser→url. */
  snippet: string
  /** Agent brand logo URL (Claude Code / Codex / …) when this is a terminal
   *  running a detected agent; null otherwise (falls back to the type icon). */
  logo: string | null
}

export interface OverviewWorkspace {
  id: string
  name: string
  color: string
  /** True when the data came from a deferred snapshot (no stable node ids). */
  deferred: boolean
  windows: OverviewWindow[]
}

/** Last path segment, for compact file/dir snippets. */
function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

/** Strip protocol + trailing slash so URLs read as host/path. */
function shortUrl(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '')
}

function snippetFromPanel(panel: PanelState): string {
  switch (panel.type) {
    case 'editor':
      return panel.filePath ? basename(panel.filePath) : 'Untitled'
    case 'terminal':
      return panel.cwd ? basename(panel.cwd) : ''
    case 'browser':
      return panel.url ? shortUrl(panel.url) : ''
    default:
      return ''
  }
}

function snippetFromSnapshot(node: NodeSnapshot): string {
  switch (node.panelType) {
    case 'editor':
      return node.filePath ? basename(node.filePath) : 'Untitled'
    case 'terminal':
      return node.workingDirectory ? basename(node.workingDirectory) : ''
    case 'browser':
      return node.url ? shortUrl(node.url) : ''
    default:
      return ''
  }
}

/** Canvas panels never live on a canvas; nothing else is filtered. */
function isCanvasWindow(type: string): boolean {
  return type === 'canvas'
}

/** Live agent logo for a terminal panel, falling back to a title match (the
 *  panel title is the agent display name and survives persistence). */
function resolveLogo(
  type: PanelType,
  title: string,
  agentLogoByPanel: Record<string, string | null>,
  panelId: string,
): string | null {
  if (type !== 'terminal') return null
  return agentLogoByPanel[panelId] ?? getAgentLogo(title)
}

function windowsFromVisited(
  workspaceId: string,
  canvasNodes: Record<string, CanvasNodeState>,
  panels: Record<string, PanelState>,
  agentLogoByPanel: Record<string, string | null>,
): OverviewWindow[] {
  const out: OverviewWindow[] = []
  for (const node of Object.values(canvasNodes)) {
    const panel = panels[node.panelId]
    if (!panel || isCanvasWindow(panel.type)) continue
    out.push({
      workspaceId,
      panelId: node.panelId,
      nodeId: node.id,
      panelType: panel.type,
      title: panel.title,
      snippet: snippetFromPanel(panel),
      logo: resolveLogo(panel.type, panel.title, agentLogoByPanel, node.panelId),
    })
  }
  return out
}

function windowsFromSnapshot(workspaceId: string, nodes: NodeSnapshot[]): OverviewWindow[] {
  const out: OverviewWindow[] = []
  for (const node of nodes) {
    if (isCanvasWindow(node.panelType)) continue
    const type = node.panelType as PanelType
    out.push({
      workspaceId,
      panelId: node.panelId,
      nodeId: null,
      panelType: type,
      title: node.title,
      // No live process for deferred workspaces — title match only.
      snippet: snippetFromSnapshot(node),
      logo: type === 'terminal' ? getAgentLogo(node.title) : null,
    })
  }
  return out
}

/**
 * Snapshot every workspace's windows for the Overview overlay. Flushes the
 * active workspace's live canvas into its WorkspaceState first so positions and
 * panels are current.
 */
export function collectOverview(): OverviewWorkspace[] {
  const app = useAppStore.getState()
  // Flush live canvas → active workspace state so we don't read stale data.
  app.syncCanvasToWorkspace(app.selectedWorkspaceId)

  // Re-read after the sync mutated the store.
  const workspaces = useAppStore.getState().workspaces
  const status = useStatusStore.getState()

  return workspaces.map((ws): OverviewWorkspace => {
    const hasLiveNodes = Object.keys(ws.canvasNodes).length > 0
    if (hasLiveNodes) {
      // Live agent name/logo keyed by panelId (gated on the process running).
      const agentInfo = selectAgentInfoByPanel(status, ws.id)
      const logoByPanel: Record<string, string | null> = {}
      for (const [panelId, info] of Object.entries(agentInfo)) logoByPanel[panelId] = info.logo
      return {
        id: ws.id,
        name: ws.name,
        color: ws.color,
        deferred: false,
        windows: windowsFromVisited(ws.id, ws.canvasNodes, ws.panels, logoByPanel),
      }
    }

    const snapshot = deferredSnapshots.get(ws.id)
    if (snapshot) {
      return {
        id: ws.id,
        name: ws.name,
        color: ws.color,
        deferred: true,
        windows: windowsFromSnapshot(ws.id, snapshot.nodes),
      }
    }

    // Empty workspace — still shown as a labeled box with no windows.
    return { id: ws.id, name: ws.name, color: ws.color, deferred: false, windows: [] }
  })
}
