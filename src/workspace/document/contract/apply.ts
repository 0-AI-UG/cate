// The document reducer. Pure and immutable: untouched parts of the document
// are shared with the input, and a failed op returns the input unchanged.
// The runtime and every client mirror run this same function.

import {
  dockPanels,
  findDockNode,
  findStack,
  insertTab,
  normalizeRatios,
  removeFromDock,
  setSplitRatios,
  splitBeside,
  splitNeedsNode,
  visitDock,
  type DockNode,
  type DockNodeId,
  type DockStack,
} from './dock'
import type { DocBatch, DocChange, DockRef, DocOp, LayoutTarget, OpErrorCode, OpResult, PlaceTarget } from './ops'
import { opChanges } from './ops'
import { docIndex, dockOf, hostOf, isCanvasDock, isNodeHost, layoutById, layoutsIn, placementOf, sameDockRef, sameHost } from './placement'
import { nodePanels, windowDockPanels } from './selectors'
import {
  MAIN_WINDOW,
  defaultLayoutName,
  type DockLayout,
  type HostRef,
  type PanelId,
  type PanelRecord,
  type SplitId,
  type WorkspaceDocument,
} from './schema'
import { checkChange } from './validate'

type Doc = WorkspaceDocument

class Fail {
  constructor(readonly code: OpErrorCode, readonly message: string) {}
}

function gone(message: string): never {
  throw new Fail('gone', `${message} is gone`)
}

function rejected(message: string): never {
  throw new Fail('rejected', message)
}

/** Apply one op (or batch, atomically). */
export function applyOp(doc: Doc, op: DocOp | DocChange | DocBatch): OpResult<Doc> {
  try {
    let next = doc
    for (const change of opChanges(op)) next = applyOne(next, change)
    return { doc: next }
  } catch (error) {
    if (error instanceof Fail) return { doc, error: { code: error.code, message: error.message } }
    throw error
  }
}

function applyOne(doc: Doc, change: DocChange): Doc {
  const problem = checkChange(change)
  if (problem) rejected(problem)
  switch (change.kind) {
    case 'addPanel': return addPanel(doc, change.record, change.at)
    case 'replacePanel': return replacePanel(doc, change.record)
    case 'updatePanel': return updatePanel(doc, change)
    case 'removePanels': return removePanels(doc, change.ids)
    case 'placePanel': return placePanel(doc, change.id, change.at)
    case 'setSplitRatio': return setSplitRatio(doc, change.splitId, change.ratios)
    case 'setNodeRects': return setNodeRects(doc, change)
    case 'closeWindow': return closeWindow(doc, change.windowId)
    case 'addLayout': return addLayout(doc, change)
    case 'removeLayout': return removeLayout(doc, change)
    case 'moveLayout': return moveLayout(doc, change)
    case 'renameLayout': return renameLayout(doc, change)
    case 'addRelation': return addRelation(doc, change)
    case 'updateRelation': return updateRelation(doc, change)
    case 'removeRelation': return removeRelation(doc, change.id)
    case 'setWorktree':
      return { ...doc, worktrees: { ...doc.worktrees, [change.worktree.id]: { ...change.worktree } } }
    case 'removeWorktree': {
      if (!doc.worktrees[change.id]) gone(`worktree ${change.id}`)
      const { [change.id]: _removed, ...worktrees } = doc.worktrees
      return { ...doc, worktrees }
    }
  }
}

// --- Docks ---------------------------------------------------------------------

/** Replace a host's layouts. A host left with no panel in any layout goes
 *  (a node or a detached window); the main window always stays. */
function setLayouts(doc: Doc, host: HostRef, layouts: DockLayout[]): Doc {
  const emptied = layouts.every((l) => l.dock === null)
  if (isNodeHost(host)) {
    const canvas = doc.canvases[host.canvasId]
    let nodes = canvas.nodes
    if (emptied) {
      const { [host.nodeId]: _removed, ...rest } = nodes
      nodes = rest
    } else nodes = { ...nodes, [host.nodeId]: { ...nodes[host.nodeId], layouts } }
    return { ...doc, canvases: { ...doc.canvases, [canvas.id]: { ...canvas, nodes } } }
  }
  const window = doc.windows[host.windowId]
  if (window.kind === 'detached' && emptied) {
    const { [window.id]: _removed, ...windows } = doc.windows
    return { ...doc, windows }
  }
  return { ...doc, windows: { ...doc.windows, [window.id]: { ...window, layouts } } }
}

/** Write a dock tree back. A window layout that empties is dropped, like a
 *  closed browser tab, unless it is the window's only one (the main window
 *  then offers the creation menu); an emptied node layout stays, empty. A host
 *  left with only empty layouts goes. */
function setDock(doc: Doc, ref: DockRef, dock: DockNode | null): Doc {
  const host = hostOf(doc, ref.layoutId)!
  const layouts = layoutsIn(doc, host)!
  const layout = layouts.find((l) => l.id === ref.layoutId)!
  if (layout.dock === dock) return doc
  const dropped = dock === null && !isNodeHost(host) && layouts.length > 1
  return setLayouts(doc, host, dropped ? layouts.filter((l) => l !== layout) : layouts.map((l) => (l === layout ? { ...l, dock } : l)))
}

/** Take a placed panel out of its dock, removing whatever that empties. */
function unplace(doc: Doc, panelId: PanelId): { doc: Doc; collapsed: Map<SplitId, DockNodeId> } {
  const placement = placementOf(doc, panelId)
  if (!placement) return { doc, collapsed: new Map() }
  const tree = dockOf(doc, placement.dock)!
  const removal = removeFromDock(tree, panelId)
  return { doc: setDock(doc, placement.dock, removal.dock), collapsed: removal.collapsed }
}

function idInUse(doc: Doc, id: string): boolean {
  const index = docIndex(doc)
  return index.stacks.has(id) || index.splits.has(id)
}

function layoutIdInUse(doc: Doc, id: string): boolean {
  return docIndex(doc).layouts.has(id)
}

function targetsCanvas(doc: Doc, target: PlaceTarget): boolean {
  return target.to === 'canvas' || (target.to === 'tab' && isNodeHost(target.host)) || ((target.to === 'stack' || target.to === 'split') && isCanvasDock(doc, target.dock))
}

/** Check that a target exists and its new ids are free. Throws otherwise. */
function checkTargetIn(doc: Doc, record: PanelRecord, target: PlaceTarget): void {
  if (record.canvasId !== undefined && targetsCanvas(doc, target)) rejected('a canvas panel cannot be placed on a canvas')
  switch (target.to) {
    case 'stack': {
      const tree = dockOf(doc, target.dock)
      if (tree === undefined) gone('dock')
      if (tree === null) {
        if (idInUse(doc, target.stackId)) rejected(`stack id ${target.stackId} is in use`)
      } else if (!findStack(tree, target.stackId)) gone(`stack ${target.stackId}`)
      return
    }
    case 'split': {
      const tree = dockOf(doc, target.dock)
      if (!tree) gone('dock')
      if (!findDockNode(tree, target.beside)) gone(`dock node ${target.beside}`)
      if (idInUse(doc, target.stackId)) rejected(`stack id ${target.stackId} is in use`)
      return
    }
    case 'canvas': {
      if (!doc.canvases[target.canvasId]) gone(`canvas ${target.canvasId}`)
      if (docIndex(doc).nodes.has(target.nodeId)) rejected(`node id ${target.nodeId} is in use`)
      if (layoutIdInUse(doc, target.layoutId)) rejected(`layout id ${target.layoutId} is in use`)
      if (idInUse(doc, target.stackId)) rejected(`stack id ${target.stackId} is in use`)
      return
    }
    case 'tab': {
      if (!layoutsIn(doc, target.host)) gone(isNodeHost(target.host) ? `node ${target.host.nodeId}` : `window ${target.host.windowId}`)
      if (layoutIdInUse(doc, target.layoutId)) rejected(`layout id ${target.layoutId} is in use`)
      if (idInUse(doc, target.stackId)) rejected(`stack id ${target.stackId} is in use`)
      return
    }
    case 'window': {
      if (doc.windows[target.windowId]) rejected(`window id ${target.windowId} is in use`)
      if (layoutIdInUse(doc, target.layoutId)) rejected(`layout id ${target.layoutId} is in use`)
      if (idInUse(doc, target.stackId)) rejected(`stack id ${target.stackId} is in use`)
      return
    }
  }
}

/** Put an unplaced panel at a target already checked with checkTargetIn. */
function placeAt(doc: Doc, panelId: PanelId, target: PlaceTarget): Doc {
  const stack = (id: string): DockStack => ({ kind: 'stack', id, panels: [panelId] })
  switch (target.to) {
    case 'stack': {
      const tree = dockOf(doc, target.dock)!
      return setDock(doc, target.dock, tree ? insertTab(tree, target.stackId, panelId, target.after) : stack(target.stackId))
    }
    case 'split': {
      const tree = dockOf(doc, target.dock)!
      if (splitNeedsNode(tree, target.beside, target.side) && idInUse(doc, target.splitId)) {
        rejected(`split id ${target.splitId} is in use`)
      }
      return setDock(doc, target.dock, splitBeside(tree, target.beside, target.side, stack(target.stackId), target.splitId))
    }
    case 'canvas': {
      const canvas = doc.canvases[target.canvasId]
      const layout = { id: target.layoutId, name: target.layoutName || defaultLayoutName([]), dock: stack(target.stackId) }
      const node = { id: target.nodeId, rect: target.rect, layouts: [layout] }
      return {
        ...doc,
        canvases: { ...doc.canvases, [canvas.id]: { ...canvas, nodes: { ...canvas.nodes, [node.id]: node } } },
      }
    }
    case 'tab': {
      const layouts = layoutsIn(doc, target.host)!
      const layout = { id: target.layoutId, name: target.layoutName || defaultLayoutName(layouts), dock: stack(target.stackId) }
      const at = target.index === undefined ? layouts.length : Math.max(0, Math.min(target.index, layouts.length))
      return withLayouts(doc, target.host, [...layouts.slice(0, at), layout, ...layouts.slice(at)])
    }
    case 'window':
      return {
        ...doc,
        windows: {
          ...doc.windows,
          [target.windowId]: {
            id: target.windowId,
            kind: 'detached',
            layouts: [{ id: target.layoutId, name: target.layoutName || defaultLayoutName([]), dock: stack(target.stackId) }],
          },
        },
      }
  }
}

// --- Records ---------------------------------------------------------------------
//
// A record that shows a canvas carries its `canvasId`; the reducer reads that,
// never the panel type.

function addPanel(doc: Doc, record: PanelRecord, at: PlaceTarget): Doc {
  if (doc.panels[record.id]) rejected(`panel id ${record.id} is in use`)
  let next: Doc = { ...doc, panels: { ...doc.panels, [record.id]: record } }
  if (record.canvasId !== undefined) {
    const canvasId = record.canvasId
    if (doc.canvases[canvasId]) rejected(`canvas id ${canvasId} is in use`)
    next = { ...next, canvases: { ...next.canvases, [canvasId]: { id: canvasId, nodes: {} } } }
  }
  checkTargetIn(next, record, at)
  return placeAt(next, record.id, at)
}

function replacePanel(doc: Doc, record: PanelRecord): Doc {
  const old = doc.panels[record.id]
  if (!old) gone(`panel ${record.id}`)
  let next: Doc = { ...doc, panels: { ...doc.panels, [record.id]: record } }
  if (old.canvasId !== undefined) {
    const canvasId = old.canvasId
    if (record.canvasId === canvasId) return next
    if (Object.keys(doc.canvases[canvasId].nodes).length > 0) rejected('only an empty canvas panel can be replaced')
    const { [canvasId]: _removed, ...canvases } = next.canvases
    next = { ...next, canvases }
  }
  if (record.canvasId !== undefined) {
    const canvasId = record.canvasId
    if (next.canvases[canvasId]) rejected(`canvas id ${canvasId} is in use`)
    const placement = placementOf(doc, record.id)
    if (placement && isCanvasDock(doc, placement.dock)) rejected('a canvas panel cannot be placed on a canvas')
    next = { ...next, canvases: { ...next.canvases, [canvasId]: { id: canvasId, nodes: {} } } }
  }
  return next
}

function updatePanel(doc: Doc, change: Extract<DocChange, { kind: 'updatePanel' }>): Doc {
  const old = doc.panels[change.id]
  if (!old) gone(`panel ${change.id}`)
  const { title, worktreeId, fields } = change.patch
  const record: PanelRecord = { ...old }
  if (title !== undefined) record.title = title
  if (worktreeId === null) delete record.worktreeId
  else if (worktreeId !== undefined) record.worktreeId = worktreeId
  if (fields) {
    const merged = { ...old.fields }
    for (const [key, value] of Object.entries(fields)) {
      if (value === null) delete merged[key]
      else merged[key] = value
    }
    record.fields = merged
  }
  return { ...doc, panels: { ...doc.panels, [change.id]: record } }
}

/** Panels a removal takes with it: the named ones, plus everything on the
 *  canvas of each canvas panel among them. */
export function removalSet(doc: Doc, ids: readonly PanelId[]): Set<PanelId> {
  const removed = new Set<PanelId>()
  for (const id of ids) {
    removed.add(id)
    const record = doc.panels[id]
    if (record?.canvasId === undefined) continue
    for (const node of Object.values(doc.canvases[record.canvasId]?.nodes ?? {})) {
      for (const panelId of nodePanels(node)) removed.add(panelId)
    }
  }
  return removed
}

function removePanels(doc: Doc, ids: readonly PanelId[]): Doc {
  for (const id of ids) if (!doc.panels[id]) gone(`panel ${id}`)
  const removed = removalSet(doc, ids)
  let next = doc
  const canvases = { ...doc.canvases }
  for (const id of removed) {
    const record = doc.panels[id]
    if (record.canvasId !== undefined) delete canvases[record.canvasId]
  }
  next = { ...next, canvases }
  for (const id of removed) {
    const placement = placementOf(next, id)
    if (placement) next = unplace(next, id).doc
  }
  const panels = { ...next.panels }
  for (const id of removed) delete panels[id]
  const relations = Object.values(next.relations).some((r) => removed.has(r.fromPanelId) || removed.has(r.toPanelId))
    ? Object.fromEntries(Object.entries(next.relations).filter(([, r]) => !removed.has(r.fromPanelId) && !removed.has(r.toPanelId)))
    : next.relations
  return { ...next, panels, relations }
}

// --- Placement -----------------------------------------------------------------

function placePanel(doc: Doc, panelId: PanelId, target: PlaceTarget): Doc {
  const record = doc.panels[panelId]
  if (!record) gone(`panel ${panelId}`)
  checkTargetIn(doc, record, target)
  const current = placementOf(doc, panelId)

  // Reordering inside its own stack never empties anything.
  if (current && target.to === 'stack' && current.stackId === target.stackId && sameDockRef(current.dock, target.dock)) {
    if (target.after === panelId) return doc
    return setDock(doc, target.dock, insertTab(dockOf(doc, target.dock)!, target.stackId, panelId, target.after))
  }

  const { doc: next, collapsed } = unplace(doc, panelId)
  // Moving out may have removed what the target names (splitting a panel's
  // one-tab stack beside itself, a node's only panel onto that node). Then
  // the panel stays where it was.
  if (target.to === 'stack' || target.to === 'split') {
    const tree = dockOf(next, target.dock)
    if (tree === undefined) return doc
    if (target.to === 'stack' && tree && !findStack(tree, target.stackId)) return doc
    if (target.to === 'split') {
      let beside: DockNodeId = target.beside
      while (collapsed.has(beside)) beside = collapsed.get(beside)!
      if (!tree || !findDockNode(tree, beside)) return doc
      return placeAt(next, panelId, { ...target, beside })
    }
  }
  if (target.to === 'tab') {
    // The host may have gone with the panel's last layout; the panel stays.
    if (!layoutsIn(next, target.host)) return doc
    // A sole layout that emptied (the main window's) would linger beside the new tab.
    const left = current && layoutById(next, current.dock.layoutId)
    if (left && left.dock === null && sameHost(hostOf(next, left.id)!, target.host)) {
      const kept = layoutsIn(next, target.host)!.filter((l) => l !== left)
      return placeAt(withLayouts(next, target.host, kept), panelId, target)
    }
  }
  return placeAt(next, panelId, target)
}

// --- Containers ------------------------------------------------------------------

function setSplitRatio(doc: Doc, splitId: SplitId, ratios: number[]): Doc {
  const ref = docIndex(doc).splits.get(splitId)
  if (!ref) gone(`split ${splitId}`)
  const tree = dockOf(doc, ref)!
  const split = findDockNode(tree, splitId)
  if (split?.kind !== 'split' || split.children.length !== ratios.length) {
    rejected(`split ${splitId} has ${split?.kind === 'split' ? split.children.length : 0} children`)
  }
  return setDock(doc, ref, setSplitRatios(tree, splitId, normalizeRatios(ratios)))
}

function setNodeRects(doc: Doc, change: Extract<DocChange, { kind: 'setNodeRects' }>): Doc {
  const canvas = doc.canvases[change.canvasId]
  if (!canvas) gone(`canvas ${change.canvasId}`)
  const nodes = { ...canvas.nodes }
  for (const { nodeId, rect } of change.rects) {
    if (!nodes[nodeId]) gone(`node ${nodeId}`)
    nodes[nodeId] = { ...nodes[nodeId], rect }
  }
  return { ...doc, canvases: { ...doc.canvases, [canvas.id]: { ...canvas, nodes } } }
}

function closeWindow(doc: Doc, windowId: string): Doc {
  const window = doc.windows[windowId]
  if (!window) gone(`window ${windowId}`)
  if (windowId === MAIN_WINDOW) rejected('the main window cannot be closed')
  return removePanels(doc, windowDockPanels(window))
}

// --- Layouts ---------------------------------------------------------------------

function addLayout(doc: Doc, change: Extract<DocChange, { kind: 'addLayout' }>): Doc {
  const layouts = layoutsIn(doc, change.host)
  if (!layouts) gone(isNodeHost(change.host) ? `node ${change.host.nodeId}` : `window ${change.host.windowId}`)
  if (layoutIdInUse(doc, change.layoutId)) rejected(`layout id ${change.layoutId} is in use`)
  const layout = { id: change.layoutId, name: change.name || defaultLayoutName(layouts), dock: null }
  const at = change.index === undefined ? layouts.length : Math.max(0, Math.min(change.index, layouts.length))
  return withLayouts(doc, change.host, [...layouts.slice(0, at), layout, ...layouts.slice(at)])
}

/** Like setLayouts, but an empty layout is added to a host that holds panels,
 *  so the host-removal rule must not fire on it. */
function withLayouts(doc: Doc, host: HostRef, layouts: DockLayout[]): Doc {
  if (isNodeHost(host)) {
    const canvas = doc.canvases[host.canvasId]
    const nodes = { ...canvas.nodes, [host.nodeId]: { ...canvas.nodes[host.nodeId], layouts } }
    return { ...doc, canvases: { ...doc.canvases, [canvas.id]: { ...canvas, nodes } } }
  }
  const window = doc.windows[host.windowId]
  return { ...doc, windows: { ...doc.windows, [window.id]: { ...window, layouts } } }
}

function removeLayout(doc: Doc, change: Extract<DocChange, { kind: 'removeLayout' }>): Doc {
  const host = hostOf(doc, change.layoutId)
  if (!host) gone(`layout ${change.layoutId}`)
  const layouts = layoutsIn(doc, host)!
  const layout = layouts.find((l) => l.id === change.layoutId)!
  if (layouts.length === 1) rejected('a host keeps at least one layout')
  // Removing the panels leaves the layout empty; it is dropped below.
  const next = removePanels(doc, dockPanels(layout.dock))
  const now = layoutsIn(next, host)
  if (!now) return next
  return setLayouts(next, host, now.filter((l) => l.id !== layout.id))
}

/** Whether a layout holds a canvas panel. */
function holdsCanvasPanel(doc: Doc, layout: DockLayout): boolean {
  return dockPanels(layout.dock).some((id) => doc.panels[id]?.canvasId !== undefined)
}

function moveLayout(doc: Doc, change: Extract<DocChange, { kind: 'moveLayout' }>): Doc {
  const from = hostOf(doc, change.layoutId)
  if (!from) gone(`layout ${change.layoutId}`)
  const source = layoutsIn(doc, from)!
  const layout = source.find((l) => l.id === change.layoutId)!
  const to: LayoutTarget = change.to
  const { to: kind } = to

  // Where the layout lands, and the host it lands in.
  let dest: HostRef
  if (kind === 'host') {
    dest = to.host
    if (!layoutsIn(doc, dest)) gone(isNodeHost(dest) ? `node ${dest.nodeId}` : `window ${dest.windowId}`)
  } else if (kind === 'window') {
    if (doc.windows[to.windowId]) rejected(`window id ${to.windowId} is in use`)
    dest = { windowId: to.windowId }
  } else {
    if (!doc.canvases[to.canvasId]) gone(`canvas ${to.canvasId}`)
    if (docIndex(doc).nodes.has(to.nodeId)) rejected(`node id ${to.nodeId} is in use`)
    dest = { canvasId: to.canvasId, nodeId: to.nodeId }
  }
  if (isNodeHost(dest) && holdsCanvasPanel(doc, layout)) rejected('a layout with a canvas panel cannot go on a canvas')
  if (kind !== 'host' && layout.dock === null) rejected('a new host needs a layout with panels')

  const same = sameHost(from, dest)
  if (same) {
    const rest = source.filter((l) => l !== layout)
    const index = kind === 'host' && to.index !== undefined ? Math.max(0, Math.min(to.index, rest.length)) : rest.length
    rest.splice(index, 0, layout)
    return withLayouts(doc, from, rest)
  }
  if (!isNodeHost(from) && from.windowId === MAIN_WINDOW && source.length === 1) rejected('the main window keeps at least one layout')

  // Leave the old host first (it may go), then join the new one.
  let next = setLayouts(doc, from, source.filter((l) => l !== layout))
  if (kind === 'window') {
    next = { ...next, windows: { ...next.windows, [to.windowId]: { id: to.windowId, kind: 'detached', layouts: [layout] } } }
  } else if (kind === 'canvas') {
    const canvas = next.canvases[to.canvasId]
    const node = { id: to.nodeId, rect: to.rect, layouts: [layout] }
    next = { ...next, canvases: { ...next.canvases, [canvas.id]: { ...canvas, nodes: { ...canvas.nodes, [node.id]: node } } } }
  } else {
    const target = layoutsIn(next, dest)!
    const index = to.index === undefined ? target.length : Math.max(0, Math.min(to.index, target.length))
    next = withLayouts(next, dest, [...target.slice(0, index), layout, ...target.slice(index)])
  }
  return next
}

function renameLayout(doc: Doc, change: Extract<DocChange, { kind: 'renameLayout' }>): Doc {
  const host = hostOf(doc, change.layoutId)
  if (!host) gone(`layout ${change.layoutId}`)
  if (!change.name.trim()) rejected('a layout needs a name')
  const layouts = layoutsIn(doc, host)!.map((l) => (l.id === change.layoutId ? { ...l, name: change.name } : l))
  return withLayouts(doc, host, layouts)
}

// --- Relations -------------------------------------------------------------------

function addRelation(doc: Doc, change: Extract<DocChange, { kind: 'addRelation' }>): Doc {
  const { relation } = change
  if (doc.relations[relation.id]) rejected(`relation id ${relation.id} is in use`)
  if (!doc.panels[relation.fromPanelId]) gone(`panel ${relation.fromPanelId}`)
  if (!doc.panels[relation.toPanelId]) gone(`panel ${relation.toPanelId}`)
  if (relation.fromPanelId === relation.toPanelId) rejected('a panel cannot relate to itself')
  if (Object.values(doc.relations).some((r) => r.fromPanelId === relation.fromPanelId && r.toPanelId === relation.toPanelId)) {
    rejected('these panels are already related')
  }
  return { ...doc, relations: { ...doc.relations, [relation.id]: { ...relation } } }
}

function updateRelation(doc: Doc, change: Extract<DocChange, { kind: 'updateRelation' }>): Doc {
  const old = doc.relations[change.id]
  if (!old) gone(`relation ${change.id}`)
  const relation = { ...old }
  for (const key of ['kind', 'label', 'fromSide', 'toSide', 'waypoint'] as const) {
    const value = change.patch[key]
    if (value === null) delete relation[key]
    else if (value !== undefined) (relation as Record<string, unknown>)[key] = value
  }
  return { ...doc, relations: { ...doc.relations, [change.id]: relation } }
}

function removeRelation(doc: Doc, id: string): Doc {
  if (!doc.relations[id]) gone(`relation ${id}`)
  const { [id]: _removed, ...relations } = doc.relations
  return { ...doc, relations }
}
