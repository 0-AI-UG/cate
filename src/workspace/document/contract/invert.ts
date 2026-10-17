// Undo (section 13.6). The inverse of an op is computed against the document
// the op applied to. It names the old ids again (a removed stack comes back
// under its own id) so a later undo of the undo still lines up. When the
// inverse is sent later, `applicable` drops the parts that no longer apply:
// what is gone, and what someone changed since the op set it.

import { jsonEqual } from '@kernel/state/contract'
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
import { opChanges, type DocBatch, type DocChange, type DocOp, type LayoutTarget, type PanelPatch, type PlaceTarget, type RelationPatch } from './ops'
import { docIndex, dockOf, hostOf, isNodeHost, layoutById, layoutsIn, placementOf } from './placement'
import { documentOrder, windowDockPanels } from './selectors'
import type { HostRef, LayoutId, PanelId, WorkspaceDocument } from './schema'

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
 *  of the ones kept before it. With `after`, the document the inverted op
 *  left, a value the op set that `doc` no longer holds (someone changed it
 *  since) is left as it is: that field, rect or ratio is dropped, and a
 *  replaced record that changed since is not put back. */
export function applicable(doc: Doc, changes: readonly DocChange[], after?: Doc): DocChange[] {
  const kept: DocChange[] = []
  const now = doc
  for (const original of changes) {
    const change = after ? unchangedPart(now, after, original) : original
    if (!change) continue
    const result = applyOp(doc, change)
    if (result.error) continue
    kept.push(change)
    doc = result.doc
  }
  return kept
}

/** The part of `change` (an inverse) whose target `now` still holds as the
 *  op left it in `after`, or null when nothing is left. */
function unchangedPart(now: Doc, after: Doc, change: DocChange): DocChange | null {
  switch (change.kind) {
    case 'replacePanel':
      return jsonEqual(now.panels[change.record.id], after.panels[change.record.id]) ? change : null
    case 'updatePanel': {
      const a = after.panels[change.id]
      const n = now.panels[change.id]
      if (!a || !n) return change
      const patch: PanelPatch = {}
      if (change.patch.title !== undefined && n.title === a.title) patch.title = change.patch.title
      if (change.patch.worktreeId !== undefined && (n.worktreeId ?? null) === (a.worktreeId ?? null)) patch.worktreeId = change.patch.worktreeId
      if (change.patch.fields) {
        const fields = Object.entries(change.patch.fields).filter(([key]) => jsonEqual(n.fields[key] ?? null, a.fields[key] ?? null))
        if (fields.length) patch.fields = Object.fromEntries(fields)
      }
      return Object.keys(patch).length ? { ...change, patch } : null
    }
    case 'updateRelation': {
      const a = after.relations[change.id]
      const n = now.relations[change.id]
      if (!a || !n) return change
      const patch = Object.fromEntries(Object.entries(change.patch).filter(([key]) =>
        jsonEqual(n[key as keyof RelationPatch] ?? null, a[key as keyof RelationPatch] ?? null)))
      return Object.keys(patch).length ? { ...change, patch } : null
    }
    case 'setNodeRects': {
      const a = after.canvases[change.canvasId]?.nodes
      const n = now.canvases[change.canvasId]?.nodes
      if (!a || !n) return change
      const rects = change.rects.filter(({ nodeId }) => !a[nodeId] || !n[nodeId] || jsonEqual(n[nodeId].rect, a[nodeId].rect))
      return rects.length ? { ...change, rects } : null
    }
    case 'setSplitRatio': {
      const a = splitRatios(after, change.splitId)
      const n = splitRatios(now, change.splitId)
      return !a || !n || jsonEqual(n, a) ? change : null
    }
    case 'setWorktree':
    case 'removeWorktree': {
      const id = change.kind === 'setWorktree' ? change.worktree.id : change.id
      return jsonEqual(now.worktrees[id], after.worktrees[id]) ? change : null
    }
    default:
      return change
  }
}

function splitRatios(doc: Doc, splitId: string): number[] | undefined {
  const ref = docIndex(doc).splits.get(splitId)
  return ref && findSplit(dockOf(doc, ref), splitId)?.ratios
}

function invertChange(before: Doc, after: Doc, change: DocChange, newId: () => string): DocChange[] {
  switch (change.kind) {
    case 'addPanel': {
      const remove: DocChange = { kind: 'removePanels', ids: [change.record.id] }
      // A panel added as a new layout's only tab can leave that layout empty behind: it goes too.
      if (change.at.to === 'tab' && layoutById(applyOp(after, remove).doc, change.at.layoutId)) {
        return [remove, { kind: 'removeLayout', layoutId: change.at.layoutId }]
      }
      return [remove]
    }
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
      return [{ kind: 'removeLayout', layoutId: change.layoutId }]
    case 'removeLayout': {
      const layout = layoutById(before, change.layoutId)!
      const panels = removalSet(before, dockPanels(layout.dock))
      // A host left with no panel went too; restoring its panels recreates it.
      if (!layoutsIn(after, hostOf(before, change.layoutId)!)) return restore(before, after, panels, 'add', newId)
      const add = addLayoutOf(before, change.layoutId, after)
      return [add, ...restore(before, applyOp(after, add).doc, panels, 'add', newId)]
    }
    case 'moveLayout': {
      const from = hostOf(before, change.layoutId)!
      const index = layoutsIn(before, from)!.findIndex((l) => l.id === change.layoutId)
      let to: LayoutTarget = { to: 'host', host: from, index }
      // Its old host went when it left: the move back creates it again.
      if (!layoutsIn(after, from)) {
        to = isNodeHost(from)
          ? { to: 'canvas', canvasId: from.canvasId, nodeId: from.nodeId, rect: before.canvases[from.canvasId].nodes[from.nodeId].rect }
          : { to: 'window', windowId: from.windowId }
      }
      return [{ kind: 'moveLayout', layoutId: change.layoutId, to }]
    }
    case 'renameLayout': {
      const old = layoutById(before, change.layoutId)!
      return [{ kind: 'renameLayout', layoutId: change.layoutId, name: old.name ?? old.id }]
    }
    case 'placePanel': {
      const back = restore(before, after, new Set([change.id]), 'move', newId)
      // A node keeps a layout its last panel left: the one a `tab` target made goes too.
      if (change.at.to !== 'tab') return back
      const undone = applyOp(after, { kind: 'batch', changes: back }).doc
      return layoutById(undone, change.at.layoutId) ? [...back, { kind: 'removeLayout', layoutId: change.at.layoutId }] : back
    }
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
    // A recreated host comes back with its first layout; add the others.
    const dock = placementOf(before, id)?.dock
    if (dock && dockOf(sim, dock) === undefined && layoutsIn(sim, hostOf(before, dock.layoutId)!)) push(addLayoutOf(before, dock.layoutId, sim))
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

/** The change that adds a layout `before` had back where it was: after the nearest earlier layout `now` still has
 *  (`now` may hold layouts `before` did not, which a later change removes). */
function addLayoutOf(before: Doc, layoutId: LayoutId, now: Doc): DocChange {
  const host = hostOf(before, layoutId)!
  const layouts = layoutsIn(before, host)!
  const layout = layouts.find((l) => l.id === layoutId)!
  const current = layoutsIn(now, host)?.map((l) => l.id) ?? []
  const earlier = layouts.slice(0, layouts.indexOf(layout)).map((l) => current.indexOf(l.id)).filter((i) => i >= 0)
  return { kind: 'addLayout', host, layoutId, index: earlier.length ? Math.max(...earlier) + 1 : 0, ...(layout.name ? { name: layout.name } : {}) }
}

/** The hosts of `doc`, as (ref, layouts) pairs. */
function hostsOf(doc: Doc): { host: HostRef; layouts: { id: LayoutId }[] }[] {
  return [
    ...Object.values(doc.windows).map((w) => ({ host: { windowId: w.id }, layouts: w.layouts })),
    ...Object.values(doc.canvases).flatMap((c) => Object.values(c.nodes).map((n) => ({ host: { canvasId: c.id, nodeId: n.id }, layouts: n.layouts }))),
  ]
}

/** Empty layouts `before` had that moving or removing panels took away
 *  (an emptied layout is removed), added back where they were. */
function restoreLayouts(before: Doc, doc: Doc): DocChange[] {
  const changes: DocChange[] = []
  let sim = doc
  for (const { host, layouts } of hostsOf(before)) {
    if (!layoutsIn(sim, host)) continue
    for (const layout of layouts) {
      if (layoutsIn(sim, host)!.some((l) => l.id === layout.id)) continue
      const change = addLayoutOf(before, layout.id, sim)
      changes.push(change)
      sim = applyOp(sim, change).doc
    }
  }
  return changes
}

/** Split ratios that differ from `before` in splits both documents have,
 *  set back. Inserting and removing a child equalises or rescales them. */
function restoreRatios(before: Doc, doc: Doc): DocChange[] {
  const changes: DocChange[] = []
  const trees = Object.values(before.windows).flatMap((w) => w.layouts.map((l) => l.dock))
    .concat(Object.values(before.canvases).flatMap((c) => Object.values(c.nodes).flatMap((n) => n.layouts.map((l) => l.dock))))
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
    const host = hostOf(before, dock.layoutId)!
    const name = layoutById(before, dock.layoutId)?.name
    if (isNodeHost(host)) {
      if (!sim.canvases[host.canvasId]) return null
      const node = before.canvases[host.canvasId].nodes[host.nodeId]
      const nodeId = docIndex(sim).nodes.has(node.id) ? newId() : node.id
      return { to: 'canvas', canvasId: host.canvasId, nodeId, layoutId: dock.layoutId, stackId: free(stack.id), rect: node.rect, ...(name ? { layoutName: name } : {}) }
    }
    return { to: 'window', windowId: host.windowId, layoutId: dock.layoutId, stackId: free(stack.id), ...(name ? { layoutName: name } : {}) }
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
