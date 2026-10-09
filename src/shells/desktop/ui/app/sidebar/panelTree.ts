// The workspace panel tree the sidebar shows, from the document: for each
// window, its canvases (canvas panels, with the panels on each canvas nested)
// and its top-level panels (every other tab of its dock). Detached windows
// follow the main window. Within a group, panels bound to the same worktree
// stay together: the primary checkout first, then the others in document
// order; otherwise document order is kept.

import {
  MAIN_WINDOW,
  dockPanels,
  dockStacks,
  panelsOnCanvas,
  type LayoutId,
  type PanelRecord,
  type StackId,
  type WindowId,
  type WorkspaceDocument,
  type WorktreeMeta,
} from '@workspace/document/contract'

export interface CanvasGroup {
  record: PanelRecord
  children: PanelRecord[]
}

/** A tab of a stack, with the panels on its canvas when it is a canvas. */
export interface StackItem {
  record: PanelRecord
  children: PanelRecord[]
}

/** One stack (split section) of a layout: its tabs in dock order. */
export interface StackGroup {
  stackId: StackId
  items: StackItem[]
}

/** One layout of a window: its canvases and top-level panels. */
export interface LayoutTree {
  layoutId: LayoutId
  name?: string
  canvases: CanvasGroup[]
  topLevel: PanelRecord[]
  /** The same panels in dock order, a group per stack: what the sidebar draws
   *  and drags (the worktree ordering above is not applied). */
  stacks: StackGroup[]
}

export interface WindowTree {
  windowId: WindowId
  /** Every layout's canvases and top-level panels, layout by layout. */
  canvases: CanvasGroup[]
  topLevel: PanelRecord[]
  /** The same panels grouped by layout, in switcher order. */
  layouts: LayoutTree[]
}

export interface WorkspacePanelTree {
  /** The window this client renders first. */
  primary: WindowTree
  /** Every other window of the workspace. */
  others: WindowTree[]
  /** Rows the tree renders. */
  count: number
}

/** Orders records by worktree: untagged and primary-checkout panels first,
 *  then each other worktree in document order, unknown tags last. Stable. */
export function sortByWorktree<P extends Pick<PanelRecord, 'worktreeId'>>(
  panels: readonly P[],
  worktrees: readonly Pick<WorktreeMeta, 'id' | 'path'>[],
  rootPath?: string,
): P[] {
  const others = worktrees.filter((w) => w.path !== rootPath)
  const rank = new Map(others.map((w, i) => [w.id, i + 1]))
  const primary = worktrees.find((w) => w.path === rootPath)
  const rankOf = (p: P): number => {
    if (!p.worktreeId || p.worktreeId === primary?.id) return 0
    return rank.get(p.worktreeId) ?? others.length + 1
  }
  return panels
    .map((panel, index) => ({ panel, index, rank: rankOf(panel) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((e) => e.panel)
}

function windowTree(doc: WorkspaceDocument, windowId: WindowId, sort: (p: PanelRecord[]) => PanelRecord[]): WindowTree {
  const layouts: LayoutTree[] = (doc.windows[windowId]?.layouts ?? []).map((layout) => {
    const canvases: CanvasGroup[] = []
    const topLevel: PanelRecord[] = []
    for (const id of dockPanels(layout.dock)) {
      const record = doc.panels[id]
      if (!record) continue
      if (record.canvasId) {
        const children = panelsOnCanvas(doc, record.canvasId).map((c) => doc.panels[c]).filter((c): c is PanelRecord => !!c)
        canvases.push({ record, children: sort(children) })
      } else {
        topLevel.push(record)
      }
    }
    const stacks: StackGroup[] = dockStacks(layout.dock).map((stack) => ({
      stackId: stack.id,
      items: stack.panels.flatMap((id) => {
        const record = doc.panels[id]
        if (!record) return []
        const children = record.canvasId
          ? sort(panelsOnCanvas(doc, record.canvasId).map((c) => doc.panels[c]).filter((c): c is PanelRecord => !!c))
          : []
        return [{ record, children }]
      }),
    }))
    return { layoutId: layout.id, ...(layout.name ? { name: layout.name } : {}), canvases, topLevel: sort(topLevel), stacks }
  })
  return {
    windowId,
    canvases: layouts.flatMap((l) => l.canvases),
    topLevel: layouts.flatMap((l) => l.topLevel),
    layouts,
  }
}

const rows = (tree: WindowTree): number =>
  tree.topLevel.length + tree.canvases.reduce((n, c) => n + 1 + c.children.length, 0)

export function workspacePanelTree(
  doc: WorkspaceDocument,
  options: { windowId?: WindowId; rootPath?: string } = {},
): WorkspacePanelTree {
  const windowId = options.windowId && doc.windows[options.windowId] ? options.windowId : MAIN_WINDOW
  const worktrees = Object.values(doc.worktrees)
  const sort = (panels: PanelRecord[]) => sortByWorktree(panels, worktrees, options.rootPath)
  const primary = windowTree(doc, windowId, sort)
  const others = Object.keys(doc.windows)
    .filter((id) => id !== windowId)
    .sort((a, b) => (a === MAIN_WINDOW ? -1 : b === MAIN_WINDOW ? 1 : 0))
    .map((id) => windowTree(doc, id, sort))
    .filter((tree) => tree.canvases.length > 0 || tree.topLevel.length > 0)
  return { primary, others, count: rows(primary) + others.reduce((n, t) => n + rows(t), 0) }
}
