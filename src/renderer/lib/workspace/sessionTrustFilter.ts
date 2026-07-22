// =============================================================================
// sessionTrustFilter — the trust boundary between a project's `.cate/` layout
// files and this machine.
//
// `.cate/workspace.json` is deliberately shareable/committable (see
// `main/cateGitignore.ts`), so its contents are attacker-controlled for any repo
// the user clones. `.cate/session.json` is gitignored but that is NOT a security
// property — a hostile repo can simply commit the file anyway — so BOTH project
// files are untrusted input here.
//
// Restoring that layout used to mount whatever panels it named. An `agent` panel
// mounts pi, which loads the project's MCP servers, which starts the commands a
// repo's `.pi/mcp.json` declares — arbitrary code on open, no click required
// (GHSA-8769-jp52-985f). Browser panels are the same shape with a different
// payload: repo-chosen URLs and a repo-chosen proxy.
//
// So: until the user explicitly trusts a project, its layout restores PASSIVE
// state only (canvas geometry, dock structure, editor/document panels rooted
// inside the project). `describeWithheld` tells the banner what was held back so
// the user can make an informed call. Trust is recorded in userData, never in
// the project.
//
// Pure module — no store or IPC access, so the whole boundary is unit-testable.
// =============================================================================

import { isProcessBearingPanelType } from '../../../shared/panels'
import { toAbsolutePath } from '../../../shared/pathUtils'
import type {
  ProjectWorkspaceFile,
  ProjectSessionFile,
  ProjectPanelRef,
  DockLayoutNode,
  WindowDockState,
  CanvasSnapshot,
  PanelType,
} from '../../../shared/types'

/** What an untrusted project's layout asked for but did not get. Drives the
 *  banner copy; empty `total` means nothing was withheld and no banner shows. */
export interface WithheldSummary {
  /** Count of withheld panels per type, e.g. `{ agent: 1, browser: 2 }`. */
  byType: Partial<Record<PanelType, number>>
  total: number
}

export interface TrustFilterResult {
  workspace: ProjectWorkspaceFile
  session: ProjectSessionFile | null
  withheld: WithheldSummary
}

/**
 * True when `relOrAbs` resolves to a location inside `rootPath`.
 *
 * An untrusted `filePath` is repo-controlled, and `toAbsolutePath` passes an
 * already-absolute path through verbatim — so without this check a repo could
 * name `/Users/victim/.ssh/id_rsa` (or climb out with `../`) and have Cate open
 * it in an editor on launch. Traversal is resolved textually rather than with
 * `path` because this runs in the renderer for both local and POSIX remote
 * roots.
 */
export function isInsideRoot(relOrAbs: string, rootPath: string): boolean {
  if (!relOrAbs || !rootPath) return false
  const abs = toAbsolutePath(relOrAbs, rootPath).replace(/\\/g, '/')
  const root = rootPath.replace(/\\/g, '/').replace(/\/+$/, '')
  // Resolve `.`/`..` segments so `<root>/../etc/passwd` can't masquerade as a
  // child of root by prefix alone.
  const segments: string[] = []
  for (const segment of abs.split('/')) {
    if (segment === '.' || segment === '') continue
    if (segment === '..') { segments.pop(); continue }
    segments.push(segment)
  }
  const resolved = (abs.startsWith('/') ? '/' : '') + segments.join('/')
  const isWindows = /^[A-Za-z]:/.test(rootPath) || rootPath.includes('\\')
  const a = isWindows ? resolved.toLowerCase() : resolved
  const b = isWindows ? root.toLowerCase() : root
  return a === b || a.startsWith(b + '/')
}

/** Panel fields that carry their own side effect and must not survive from an
 *  untrusted file even on a panel type that is otherwise passive. `proxyUrl`
 *  would route a panel's traffic through a repo-chosen proxy; `tabs` names the
 *  URLs a browser loads; the extension ids select which extension server runs. */
const UNTRUSTED_PANEL_FIELDS = ['tabs', 'activeTabId', 'proxyUrl', 'extensionId', 'extensionPanelId'] as const

/**
 * Reduce a project's layout files to what is safe to restore without an explicit
 * trust decision. Passive panels survive; process-bearing ones are dropped along
 * with every dock/canvas reference to them, so no empty stacks or ghost nodes
 * are left behind.
 */
export function filterUntrustedProjectFiles(
  ws: ProjectWorkspaceFile,
  sess: ProjectSessionFile | null,
  rootPath: string,
): TrustFilterResult {
  const byType: Partial<Record<PanelType, number>> = {}
  let total = 0

  const keptPanels: Record<string, ProjectPanelRef> = {}
  for (const [id, ref] of Object.entries(ws.panels ?? {})) {
    const type = ref.type as PanelType
    // A repo-authored path outside the project is treated exactly like a
    // process-bearing panel: withheld, and reported so the user sees it.
    const escapesRoot = !!ref.filePath && !isInsideRoot(ref.filePath, rootPath)
    if (isProcessBearingPanelType(type) || escapesRoot) {
      byType[type] = (byType[type] ?? 0) + 1
      total++
      continue
    }
    const kept: ProjectPanelRef = { ...ref }
    for (const field of UNTRUSTED_PANEL_FIELDS) delete kept[field]
    keptPanels[id] = kept
  }

  const allowed = new Set(Object.keys(keptPanels))

  // session.json is untrusted input too (a repo can commit it), and its
  // per-panel facts are all machine-local side effects: `workingDirectory`
  // respawns a terminal somewhere of the repo's choosing, `agentSession` types a
  // resume command into a shell, `worktreeId` re-points a panel at another
  // checkout. None of it is meaningful for the passive panels that survive
  // above, so an untrusted project contributes no session panels at all.
  const filteredSession: ProjectSessionFile | null = sess
    ? {
        ...sess,
        panels: {},
        // Detached windows re-open panels in their own shells — same boundary.
        dockWindows: undefined,
        worktrees: undefined,
      }
    : null

  return {
    workspace: {
      ...ws,
      panels: keptPanels,
      dockState: ws.dockState ? { zones: pruneDockZones(ws.dockState.zones, allowed) } : ws.dockState,
      canvases: ws.canvases ? pruneCanvases(ws.canvases, allowed) : ws.canvases,
    },
    session: filteredSession,
    withheld: { byType, total },
  }
}

/** Drop every zone layout reference to a panel that didn't survive the filter. */
export function pruneDockZones(zones: WindowDockState, allowed: Set<string>): WindowDockState {
  const out = {} as WindowDockState
  for (const name of Object.keys(zones ?? {}) as (keyof WindowDockState)[]) {
    const zone = zones[name]
    if (!zone) continue
    out[name] = { ...zone, layout: pruneLayout(zone.layout, allowed) }
  }
  return out
}

/** Recursively strip disallowed panel ids, dropping stacks that empty out and
 *  collapsing splits down to their surviving children (ratios re-normalized).
 *  Returns null when nothing survives. */
export function pruneLayout(
  layout: DockLayoutNode | null | undefined,
  allowed: Set<string>,
): DockLayoutNode | null {
  if (!layout) return null
  if (layout.type === 'tabs') {
    const panelIds = layout.panelIds.filter((id) => allowed.has(id))
    if (panelIds.length === 0) return null
    // Keep the same panel active where possible; otherwise fall back to the first.
    const previouslyActive = layout.panelIds[layout.activeIndex]
    const activeIndex = Math.max(0, panelIds.indexOf(previouslyActive))
    return { ...layout, panelIds, activeIndex }
  }

  const kept: { child: DockLayoutNode; ratio: number }[] = []
  layout.children.forEach((child, i) => {
    const pruned = pruneLayout(child, allowed)
    if (pruned) kept.push({ child: pruned, ratio: layout.ratios[i] ?? 0 })
  })
  if (kept.length === 0) return null
  // A split with one surviving child is just that child.
  if (kept.length === 1) return kept[0].child
  const sum = kept.reduce((acc, k) => acc + k.ratio, 0)
  const ratios = sum > 0 ? kept.map((k) => k.ratio / sum) : kept.map(() => 1 / kept.length)
  return { ...layout, children: kept.map((k) => k.child), ratios }
}

/** Prune each canvas's node layouts, dropping nodes left holding nothing. */
function pruneCanvases(
  canvases: Record<string, CanvasSnapshot>,
  allowed: Set<string>,
): Record<string, CanvasSnapshot> {
  const out: Record<string, CanvasSnapshot> = {}
  for (const [canvasPanelId, canvas] of Object.entries(canvases)) {
    // A canvas whose own panel record didn't survive has nothing to render into.
    if (!allowed.has(canvasPanelId)) continue
    const canvasNodes: typeof canvas.canvasNodes = {}
    for (const [nodeId, node] of Object.entries(canvas.canvasNodes ?? {})) {
      const dockLayout = pruneLayout(node.dockLayout, allowed)
      if (!dockLayout) continue
      canvasNodes[nodeId] = { ...node, dockLayout }
    }
    out[canvasPanelId] = { ...canvas, canvasNodes }
  }
  return out
}

/** Human-readable list for the trust banner, e.g. "1 Agent panel, 2 browser tabs". */
export function describeWithheld(withheld: WithheldSummary): string {
  const labels: Partial<Record<PanelType, [string, string]>> = {
    agent: ['Agent panel', 'Agent panels'],
    terminal: ['terminal', 'terminals'],
    browser: ['browser panel', 'browser panels'],
    extension: ['extension panel', 'extension panels'],
    editor: ['file outside this project', 'files outside this project'],
    document: ['document outside this project', 'documents outside this project'],
  }
  const parts: string[] = []
  for (const [type, count] of Object.entries(withheld.byType) as [PanelType, number][]) {
    if (!count) continue
    const [one, many] = labels[type] ?? [type, `${type} panels`]
    parts.push(`${count} ${count === 1 ? one : many}`)
  }
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]
  return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1]
}
