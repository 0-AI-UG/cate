// Seeded random document changes for property tests (the op convergence test,
// undo round trips). Most changes are valid against the document they are
// made for; some name ids that never existed, and applied to a different
// document (another client's view) many turn stale. Not part of the contract
// entry; tests import it directly.

import { rect, type Rect } from '@workspace/canvas/contract'
import { dockStacks, visitDock, type SplitSide } from './dock'
import { placementOf } from './placement'
import type { DocChange, PlaceTarget } from './ops'
import { PANEL_TYPES, type PanelRecord, type PanelType, type WorkspaceDocument } from './schema'
import { allStacks } from './selectors'

export interface Rng {
  next(): number
  int(n: number): number
  pick<T>(items: readonly T[]): T
  chance(p: number): boolean
}

/** mulberry32 */
export function createRng(seed: number): Rng {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (items) => items[Math.floor(next() * items.length)],
    chance: (p) => next() < p,
  }
}

const SIDES: SplitSide[] = ['left', 'right', 'top', 'bottom']

function randomRect(rng: Rng): Rect {
  return rect(rng.int(40) * 20 - 400, rng.int(40) * 20 - 400, 200 + rng.int(20) * 20, 150 + rng.int(20) * 20)
}

function randomTarget(doc: WorkspaceDocument, rng: Rng, newId: () => string, canvasPanel: boolean): PlaceTarget {
  const stacks = allStacks(doc).filter(({ dock }) => !canvasPanel || !('canvasId' in dock))
  const canvases = Object.keys(doc.canvases)
  const roll = rng.int(10)
  if (roll < 4 && stacks.length) {
    const { dock, stack } = rng.pick(stacks)
    const after = rng.chance(0.2) ? null : rng.chance(0.3) ? 'no-such-panel' : rng.chance(0.5) ? rng.pick(stack.panels) : undefined
    return { to: 'stack', dock, stackId: stack.id, after }
  }
  if (roll < 6 && stacks.length) {
    const { dock } = rng.pick(stacks)
    const tree = 'canvasId' in dock
      ? doc.canvases[dock.canvasId].nodes[dock.nodeId].dock
      : doc.windows[dock.windowId].layouts.find((l) => l.id === dock.layoutId)!.dock
    const ids: string[] = []
    visitDock(tree, (n) => { ids.push(n.id) })
    return { to: 'split', dock, beside: rng.pick(ids), side: rng.pick(SIDES), stackId: newId(), splitId: newId() }
  }
  if (roll < 8 && canvases.length && !canvasPanel) {
    return { to: 'canvas', canvasId: rng.pick(canvases), nodeId: newId(), stackId: newId(), rect: randomRect(rng) }
  }
  // An empty layout takes a first stack.
  const empty = Object.values(doc.windows).flatMap((w) => w.layouts.filter((l) => !l.dock).map((l) => ({ windowId: w.id, layoutId: l.id })))
  if (empty.length && rng.chance(0.7)) return { to: 'stack', dock: rng.pick(empty), stackId: newId() }
  return { to: 'window', windowId: newId(), layoutId: rng.pick(['main', newId()]), stackId: newId() }
}

function randomRecord(rng: Rng, newId: () => string, type: PanelType): PanelRecord {
  const record: PanelRecord = { id: newId(), type, title: `${type} ${rng.int(100)}`, fields: {} }
  if (type === 'canvas') record.canvasId = newId()
  if (rng.chance(0.3)) record.fields = { n: rng.int(10) }
  return record
}

/** One random change for `doc`. */
export function randomChange(doc: WorkspaceDocument, rng: Rng, newId: () => string): DocChange {
  const panels = Object.values(doc.panels)
  const panelIds = panels.map((p) => p.id)
  const someId = () => (panelIds.length && !rng.chance(0.05) ? rng.pick(panelIds) : 'no-such-panel')
  const splits: string[] = []
  for (const w of Object.values(doc.windows)) {
    for (const l of w.layouts) visitDock(l.dock, (n) => { if (n.kind === 'split') splits.push(n.id) })
  }
  for (const c of Object.values(doc.canvases)) {
    for (const n of Object.values(c.nodes)) visitDock(n.dock, (d) => { if (d.kind === 'split') splits.push(d.id) })
  }
  const detached = Object.values(doc.windows).filter((w) => w.kind === 'detached')
  const canvases = Object.values(doc.canvases).filter((c) => Object.keys(c.nodes).length > 0)
  const relations = Object.values(doc.relations)
  const worktrees = Object.values(doc.worktrees)

  const roll = rng.int(100)
  if (roll < 22 || panelIds.length < 2) {
    const type = rng.chance(0.12) ? 'canvas' : rng.pick(PANEL_TYPES.filter((t) => t !== 'canvas'))
    const record = randomRecord(rng, newId, type)
    return { kind: 'addPanel', record, at: randomTarget(doc, rng, newId, type === 'canvas') }
  }
  if (roll < 45) {
    const id = someId()
    return { kind: 'placePanel', id, at: randomTarget(doc, rng, newId, doc.panels[id]?.type === 'canvas') }
  }
  if (roll < 52) {
    const ids = [someId()]
    if (rng.chance(0.3)) ids.push(someId())
    return { kind: 'removePanels', ids: [...new Set(ids)] }
  }
  if (roll < 60) {
    const id = someId()
    const patch = rng.pick([
      { title: `t${rng.int(100)}` },
      { worktreeId: worktrees.length && rng.chance(0.7) ? rng.pick(worktrees).id : null },
      { fields: { n: rng.chance(0.3) ? null : rng.int(10), m: rng.int(3) } },
    ])
    return { kind: 'updatePanel', id, patch }
  }
  if (roll < 63) {
    const id = someId()
    const old = doc.panels[id]
    const type = rng.chance(0.2) ? 'canvas' : rng.pick(PANEL_TYPES.filter((t) => t !== 'canvas'))
    const record = randomRecord(rng, newId, type)
    return { kind: 'replacePanel', record: { ...record, id: old ? id : record.id } }
  }
  if (roll < 70 && splits.length) {
    return { kind: 'setSplitRatio', splitId: rng.pick(splits), ratios: [1 + rng.int(4), 1 + rng.int(4)] }
  }
  if (roll < 81 && canvases.length) {
    const canvas = rng.pick(canvases)
    const nodes = Object.keys(canvas.nodes)
    return { kind: 'setNodeRects', canvasId: canvas.id, rects: [{ nodeId: rng.pick(nodes), rect: randomRect(rng) }] }
  }
  if (roll < 83 && detached.length) {
    return { kind: 'closeWindow', windowId: rng.pick(detached).id }
  }
  if (roll < 86) {
    const window = rng.pick(Object.values(doc.windows))
    const layout = rng.pick(window.layouts)
    const pick = rng.int(4)
    if (pick === 3) return { kind: 'moveLayout', windowId: window.id, layoutId: layout.id, index: rng.int(window.layouts.length + 1) }
    if (pick === 0) return { kind: 'addLayout', windowId: window.id, layoutId: rng.chance(0.1) ? layout.id : newId(), name: rng.chance(0.5) ? `L${rng.int(9)}` : undefined }
    if (pick === 1) return { kind: 'removeLayout', windowId: window.id, layoutId: layout.id }
    return { kind: 'renameLayout', windowId: window.id, layoutId: layout.id, name: `n${rng.int(9)}` }
  }
  if (roll < 88) {
    return {
      kind: 'addRelation',
      relation: { id: newId(), fromPanelId: someId(), toPanelId: someId(), kind: rng.pick(['use', 'context', 'verify', 'trigger'] as const) },
    }
  }
  if (roll < 91 && relations.length) {
    return { kind: 'updateRelation', id: rng.pick(relations).id, patch: rng.chance(0.5) ? { label: `l${rng.int(9)}` } : { label: null, waypoint: { x: rng.int(99), y: 1 } } }
  }
  if (roll < 93 && relations.length) return { kind: 'removeRelation', id: rng.pick(relations).id }
  if (roll < 97) {
    const old = worktrees.length && rng.chance(0.5) ? rng.pick(worktrees) : null
    return {
      kind: 'setWorktree',
      worktree: {
        id: old?.id ?? newId(),
        path: old?.path ?? `/repo/.cate/worktrees/${rng.int(1000)}`,
        color: rng.pick(['#f00', '#0f0', '#00f']),
        status: rng.pick(['creating', 'ready', 'removing'] as const),
      },
    }
  }
  return { kind: 'removeWorktree', id: worktrees.length ? rng.pick(worktrees).id : 'no-such-worktree' }
}
