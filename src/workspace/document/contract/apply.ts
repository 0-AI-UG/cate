// The document reducer. Pure and immutable: untouched parts of the document
// are shared with the input, and a failed op returns the input unchanged.
// The runtime and every client mirror run this same function.

import type { CanvasModel, CanvasNode } from '@workspace/canvas/contract'
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
  type DockNode,
  type DockNodeId,
  type DockStack,
} from './dock'
import type { DocBatch, DocChange, DockRef, DocOp, OpErrorCode, OpResult, PlaceTarget } from './ops'
import { opChanges } from './ops'
import { docIndex, dockOf, isCanvasDock, placementOf, sameDockRef } from './placement'
import { MAIN_WINDOW, type PanelId, type PanelRecord, type SplitId, type WorkspaceDocument } from './schema'
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
    case 'setWindowBounds': return setWindowBounds(doc, change)
    case 'closeWindow': return closeWindow(doc, change.windowId)
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

/** Write a dock tree back. An emptied node or detached window goes with it. */
function setDock(doc: Doc, ref: DockRef, dock: DockNode | null): Doc {
  if (isCanvasDock(ref)) {
    const canvas = doc.canvases[ref.canvasId]
    const node = canvas.nodes[ref.nodeId]
    if (node.dock === dock) return doc
    let nodes: CanvasModel['nodes']
    if (dock) nodes = { ...canvas.nodes, [ref.nodeId]: { ...node, dock } }
    else {
      const { [ref.nodeId]: _removed, ...rest } = canvas.nodes
      nodes = rest
    }
    return { ...doc, canvases: { ...doc.canvases, [canvas.id]: { ...canvas, nodes } } }
  }
  const window = doc.windows[ref.windowId]
  if (window.dock === dock) return doc
  if (!dock && window.kind === 'detached') {
    const { [window.id]: _removed, ...windows } = doc.windows
    return { ...doc, windows }
  }
  return { ...doc, windows: { ...doc.windows, [window.id]: { ...window, dock } } }
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

function targetsCanvas(target: PlaceTarget): boolean {
  return target.to === 'canvas' || ((target.to === 'stack' || target.to === 'split') && isCanvasDock(target.dock))
}

/** Check that a target exists and its new ids are free. Throws otherwise. */
function checkTargetIn(doc: Doc, record: PanelRecord, target: PlaceTarget): void {
  if (record.type === 'canvas' && targetsCanvas(target)) rejected('a canvas panel cannot be placed on a canvas')
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
      if (idInUse(doc, target.stackId)) rejected(`stack id ${target.stackId} is in use`)
      return
    }
    case 'window': {
      if (doc.windows[target.windowId]) rejected(`window id ${target.windowId} is in use`)
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
      const node: CanvasNode = { id: target.nodeId, rect: target.rect, dock: stack(target.stackId) }
      return {
        ...doc,
        canvases: { ...doc.canvases, [canvas.id]: { ...canvas, nodes: { ...canvas.nodes, [node.id]: node } } },
      }
    }
    case 'window':
      return {
        ...doc,
        windows: {
          ...doc.windows,
          [target.windowId]: { id: target.windowId, kind: 'detached', dock: stack(target.stackId), bounds: target.bounds },
        },
      }
  }
}

// --- Records ---------------------------------------------------------------------

function addPanel(doc: Doc, record: PanelRecord, at: PlaceTarget): Doc {
  if (doc.panels[record.id]) rejected(`panel id ${record.id} is in use`)
  let next: Doc = { ...doc, panels: { ...doc.panels, [record.id]: record } }
  if (record.type === 'canvas') {
    const canvasId = record.canvasId!
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
  if (old.type === 'canvas') {
    const canvasId = old.canvasId!
    if (record.type === 'canvas' && record.canvasId === canvasId) return next
    if (Object.keys(doc.canvases[canvasId].nodes).length > 0) rejected('only an empty canvas panel can be replaced')
    const { [canvasId]: _removed, ...canvases } = next.canvases
    next = { ...next, canvases }
  }
  if (record.type === 'canvas') {
    const canvasId = record.canvasId!
    if (next.canvases[canvasId]) rejected(`canvas id ${canvasId} is in use`)
    const placement = placementOf(doc, record.id)
    if (placement && isCanvasDock(placement.dock)) rejected('a canvas panel cannot be placed on a canvas')
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
    if (record?.type !== 'canvas') continue
    for (const node of Object.values(doc.canvases[record.canvasId!]?.nodes ?? {})) {
      for (const panelId of dockPanels(node.dock)) removed.add(panelId)
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
    if (record.type === 'canvas') delete canvases[record.canvasId!]
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

function setWindowBounds(doc: Doc, change: Extract<DocChange, { kind: 'setWindowBounds' }>): Doc {
  const window = doc.windows[change.windowId]
  if (!window) gone(`window ${change.windowId}`)
  if (window.kind === 'main') rejected('the main window has no shared bounds')
  return { ...doc, windows: { ...doc.windows, [window.id]: { ...window, bounds: change.bounds } } }
}

function closeWindow(doc: Doc, windowId: string): Doc {
  const window = doc.windows[windowId]
  if (!window) gone(`window ${windowId}`)
  if (windowId === MAIN_WINDOW) rejected('the main window cannot be closed')
  return removePanels(doc, dockPanels(window.dock))
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
