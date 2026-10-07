// Undo (section 13.6). The inverse of an op is computed against the document
// the op applied to. It names the old ids again (a removed stack comes back
// under its own id) so a later undo of the undo still lines up. When the
// inverse is sent later, `applicable` drops the parts that no longer apply.

import { applyOp } from './apply'
import { removalSet } from './apply'
import {
  dockPanels,
  dockStacks,
  findDockNode,
  findSplit,
  findStack,
  parentOf,
  splitNeedsNode,
  visitDock,
  type DockNode,
  type DockNodeId,
  type SplitSide,
} from './dock'
import { opChanges, type DocBatch, type DocChange, type DocOp, type PanelPatch, type PlaceTarget, type RelationPatch } from './ops'
import { docIndex, dockOf, isCanvasDock, placementOf } from './placement'
import { documentOrder, windowDockPanels } from './selectors'
import type { PanelId, WorkspaceDocument } from './schema'

type Doc = WorkspaceDocument

/** The changes that undo `op`, computed against `before`, the document it
 *  applied to. Empty when the op fails on `before`. `newId` is called only
 *  when an old id cannot be reused. */
export function invertOp(before: Doc, op: DocOp | DocChange | DocBatch, newId: () => string): DocChange[] {
  const parts: DocChange[][] = []
  let doc = before
  for (const change of opChanges(op)) {
    const result = applyOp(doc, change)
    if (result.error) return []
    const inverse = invertChange(doc, result.doc, change, newId)
    const undone = applyOp(result.doc, { kind: 'batch', changes: inverse }).doc
    const ratios = restoreRatios(doc, undone)
    const layouts = restoreLayouts(doc, applyOp(undone, { kind: 'batch', changes: ratios }).doc)
    parts.push([...inverse, ...ratios, ...layouts])
    doc = result.doc
  }
  return parts.reverse().flat()
}

/** The changes that still apply to `doc`, in order, each tried on the result
 *  of the ones kept before it. */
export function applicable(doc: Doc, changes: readonly DocChange[]): DocChange[] {
  const kept: DocChange[] = []
  for (const change of changes) {
    const result = applyOp(doc, change)
    if (result.error) continue
    kept.push(change)
    doc = result.doc
  }
  return kept
}

function invertChange(before: Doc, after: Doc, change: DocChange, newId: () => string): DocChange[] {
  switch (change.kind) {
    case 'addPanel':
      return [{ kind: 'removePanels', ids: [change.record.id] }]
    case 'replacePanel':
      return [{ kind: 'replacePanel', record: before.panels[change.record.id] }]
    case 'updatePanel': {
      const old = before.panels[change.id]
      const patch: PanelPatch = {}
      if (change.patch.title !== undefined) patch.title = old.title
      if (change.patch.worktreeId !== undefined) patch.worktreeId = old.worktreeId ?? null
      if (change.patch.fields) {
        patch.fields = Object.fromEntries(Object.keys(change.patch.fields).map((key) => [key, old.fields[key] ?? null]))
      }
      return [{ kind: 'updatePanel', id: change.id, patch }]
    }
    case 'removePanels':
      return restore(before, after, removalSet(before, change.ids), 'add', newId)
    case 'closeWindow':
      return restore(before, after, removalSet(before, windowDockPanels(before.windows[change.windowId])), 'add', newId)
    case 'addLayout':
      return [{ kind: 'removeLayout', windowId: change.windowId, layoutId: change.layoutId }]
    case 'removeLayout': {
      const layouts = before.windows[change.windowId].layouts
      const layout = layouts.find((l) => l.id === change.layoutId)!
      const add: DocChange = { kind: 'addLayout', windowId: change.windowId, layoutId: layout.id, index: layouts.indexOf(layout), ...(layout.name ? { name: layout.name } : {}) }
      // A detached window left with no panel went too; restoring its panels recreates it.
      if (!after.windows[change.windowId]) return restore(before, after, removalSet(before, dockPanels(layout.dock)), 'add', newId)
      const sim = applyOp(after, add).doc
      return [add, ...restore(before, sim, removalSet(before, dockPanels(layout.dock)), 'add', newId)]
    }
    case 'renameLayout': {
      const old = before.windows[change.windowId].layouts.find((l) => l.id === change.layoutId)!
      return [{ kind: 'renameLayout', windowId: change.windowId, layoutId: change.layoutId, name: old.name ?? null }]
    }
    case 'placePanel':
      return restore(before, after, new Set([change.id]), 'move', newId)
    case 'setSplitRatio': {
      const ref = docIndex(before).splits.get(change.splitId)!
      const split = findSplit(dockOf(before, ref), change.splitId)!
      return [{ kind: 'setSplitRatio', splitId: change.splitId, ratios: split.ratios }]
    }
    case 'setNodeRects': {
      const nodes = before.canvases[change.canvasId].nodes
      return [{ kind: 'setNodeRects', canvasId: change.canvasId, rects: change.rects.map(({ nodeId }) => ({ nodeId, rect: nodes[nodeId].rect })) }]
    }
    case 'addRelation':
      return [{ kind: 'removeRelation', id: change.relation.id }]
    case 'updateRelation': {
      const old = before.relations[change.id]
      const patch: RelationPatch = {}
      for (const key of Object.keys(change.patch) as (keyof RelationPatch)[]) {
        if (change.patch[key] !== undefined) (patch as Record<string, unknown>)[key] = old[key] ?? null
      }
      return [{ kind: 'updateRelation', id: change.id, patch }]
    }
    case 'removeRelation':
      return [{ kind: 'addRelation', relation: before.relations[change.id] }]
    case 'setWorktree': {
      const old = before.worktrees[change.worktree.id]
      return [old ? { kind: 'setWorktree', worktree: old } : { kind: 'removeWorktree', id: change.worktree.id }]
    }
    case 'removeWorktree':
      return [{ kind: 'setWorktree', worktree: before.worktrees[change.id] }]
  }
}

/** Put `panels` back where they were in `before`: re-add them (`add`) or move
 *  them (`move`), in document order so each one's neighbours are back first,
 *  then restore their relations. */
function restore(before: Doc, after: Doc, panels: Set<PanelId>, mode: 'add' | 'move', newId: () => string): DocChange[] {
  const changes: DocChange[] = []
  let sim = after
  const push = (change: DocChange) => {
    const result = applyOp(sim, change)
    if (result.error) return
    sim = result.doc
    changes.push(change)
  }

  for (const id of documentOrder(before)) {
    if (!panels.has(id)) continue
    // A closed window comes back with its first layout; recreate the others.
    const dock = placementOf(before, id)?.dock
    if (dock && !isCanvasDock(dock) && sim.windows[dock.windowId] && dockOf(sim, dock) === undefined) {
      const layouts = before.windows[dock.windowId].layouts
      const layout = layouts.find((l) => l.id === dock.layoutId)
      if (layout) push({ kind: 'addLayout', windowId: dock.windowId, layoutId: layout.id, index: layouts.indexOf(layout), ...(layout.name ? { name: layout.name } : {}) })
    }
    const at = targetLike(before, sim, id, newId)
    if (!at) continue
    push(mode === 'add' ? { kind: 'addPanel', record: before.panels[id], at } : { kind: 'placePanel', id, at })
  }
  if (mode === 'add') {
    for (const relation of Object.values(before.relations)) {
      if (panels.has(relation.fromPanelId) || panels.has(relation.toPanelId)) push({ kind: 'addRelation', relation })
    }
  }
  return changes
}

/** Empty layouts `before` had that moving or removing panels took away
 *  (an emptied layout is removed), added back where they were. */
function restoreLayouts(before: Doc, doc: Doc): DocChange[] {
  const changes: DocChange[] = []
  for (const window of Object.values(before.windows)) {
    const now = doc.windows[window.id]
    if (!now) continue
    window.layouts.forEach((layout, index) => {
      if (now.layouts.some((l) => l.id === layout.id)) return
      changes.push({ kind: 'addLayout', windowId: window.id, layoutId: layout.id, index, ...(layout.name ? { name: layout.name } : {}) })
    })
  }
  return changes
}

/** Split ratios that differ from `before` in splits both documents have,
 *  set back. Inserting and removing a child equalises or rescales them. */
function restoreRatios(before: Doc, doc: Doc): DocChange[] {
  const changes: DocChange[] = []
  const trees = [
    ...Object.values(before.windows).flatMap((w) => w.layouts.map((l) => l.dock)),
    ...Object.values(before.canvases).flatMap((c) => Object.values(c.nodes).map((n) => n.dock)),
  ]
  for (const tree of trees) {
    visitDock(tree, (node) => {
      if (node.kind !== 'split') return
      const ref = docIndex(doc).splits.get(node.id)
      const now = ref && findSplit(dockOf(doc, ref), node.id)
      if (!now || now.children.length !== node.ratios.length) return
      if (now.ratios.every((r, i) => Math.abs(r - node.ratios[i]) < 1e-9)) return
      changes.push({ kind: 'setSplitRatio', splitId: node.id, ratios: node.ratios })
    })
  }
  return changes
}

/** A target that puts `panelId` into `sim` where it was in `before`. */
function targetLike(before: Doc, sim: Doc, panelId: PanelId, newId: () => string): PlaceTarget | null {
  const placement = placementOf(before, panelId)
  if (!placement) return null
  const dock = placement.dock
  const beforeTree = dockOf(before, dock)!
  const stack = findStack(beforeTree, placement.stackId)!
  const free = (id: string) => docIndex(sim).stacks.has(id) || docIndex(sim).splits.has(id) ? newId() : id
  const simTree = dockOf(sim, dock)

  if (simTree === undefined) {
    if (isCanvasDock(dock)) {
      if (!sim.canvases[dock.canvasId]) return null
      const node = before.canvases[dock.canvasId].nodes[dock.nodeId]
      const nodeId = docIndex(sim).nodes.has(node.id) ? newId() : node.id
      return { to: 'canvas', canvasId: dock.canvasId, nodeId, stackId: free(stack.id), rect: node.rect }
    }
    const name = before.windows[dock.windowId].layouts.find((l) => l.id === dock.layoutId)?.name
    return { to: 'window', windowId: dock.windowId, layoutId: dock.layoutId, stackId: free(stack.id), ...(name ? { layoutName: name } : {}) }
  }
  if (simTree === null) return { to: 'stack', dock, stackId: free(stack.id) }

  const simStack = findStack(simTree, stack.id)
  if (simStack) {
    let after: PanelId | null = null
    for (let i = placement.index - 1; i >= 0; i--) {
      const candidate = stack.panels[i]
      if (candidate !== panelId && simStack.panels.includes(candidate)) {
        after = candidate
        break
      }
    }
    return { to: 'stack', dock, stackId: stack.id, after }
  }

  // The stack is gone: recreate it beside its nearest surviving neighbour,
  // climbing the old tree until one side still exists.
  let node: DockNode = stack
  for (;;) {
    const parent = parentOf(beforeTree, node.id)
    if (!parent) break
    const { parent: split, index } = parent
    const horizontal = split.direction === 'horizontal'
    const beside = (rep: DockNodeId, side: SplitSide): PlaceTarget => ({
      to: 'split',
      dock,
      beside: rep,
      side,
      stackId: free(stack.id),
      splitId: splitNeedsNode(simTree, rep, side) && (docIndex(sim).splits.has(split.id) || docIndex(sim).stacks.has(split.id))
        ? newId()
        : split.id,
    })
    for (let j = index - 1; j >= 0; j--) {
      const rep = survivor(simTree, split.children[j], true)
      if (rep) return beside(rep, horizontal ? 'right' : 'bottom')
    }
    for (let j = index + 1; j < split.children.length; j++) {
      const rep = survivor(simTree, split.children[j], false)
      if (rep) return beside(rep, horizontal ? 'left' : 'top')
    }
    node = split
  }
  return { to: 'stack', dock, stackId: dockStacks(simTree)[0].id }
}

/** The node standing in `tree` for an old node: itself, or for a split that
 *  collapsed, its surviving child nearest the side we come from. */
function survivor(tree: DockNode, old: DockNode, fromEnd: boolean): DockNodeId | null {
  if (findDockNode(tree, old.id)) return old.id
  if (old.kind === 'stack') return null
  const children = fromEnd ? [...old.children].reverse() : old.children
  for (const child of children) {
    const rep = survivor(tree, child, fromEnd)
    if (rep) return rep
  }
  return null
}
