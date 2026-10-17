// Dock trees: the layout of a window, and the mini dock of a canvas node.
// Stacks hold tabs; splits hold two or more children side by side. Which tab
// of a stack is active is client state and not in the tree.

import type { PanelId, SplitId, StackId } from './schema'

export interface DockStack {
  kind: 'stack'
  id: StackId
  /** Never empty. */
  panels: PanelId[]
}

export interface DockSplit {
  kind: 'split'
  id: SplitId
  /** `horizontal` lays children out left to right, `vertical` top to bottom. */
  direction: 'horizontal' | 'vertical'
  /** Two or more. */
  children: DockNode[]
  /** One per child, each > 0, summing to 1. */
  ratios: number[]
}

export type DockNode = DockStack | DockSplit
export type DockNodeId = StackId | SplitId
export type SplitSide = 'left' | 'right' | 'top' | 'bottom'

/** Depth-first visit; stop early by returning true. */
export function visitDock(
  node: DockNode | null | undefined,
  visitor: (node: DockNode) => boolean | void,
): boolean {
  if (!node) return false
  if (visitor(node) === true) return true
  if (node.kind === 'split') {
    for (const child of node.children) if (visitDock(child, visitor)) return true
  }
  return false
}

/** Every panel in the tree, in tree order. */
export function dockPanels(node: DockNode | null | undefined): PanelId[] {
  const out: PanelId[] = []
  visitDock(node, (n) => { if (n.kind === 'stack') out.push(...n.panels) })
  return out
}

/** Every stack in the tree, in tree order. */
export function dockStacks(node: DockNode | null | undefined): DockStack[] {
  const out: DockStack[] = []
  visitDock(node, (n) => { if (n.kind === 'stack') out.push(n) })
  return out
}

export function findDockNode(node: DockNode | null | undefined, id: DockNodeId): DockNode | null {
  let found: DockNode | null = null
  visitDock(node, (n) => {
    if (n.id !== id) return false
    found = n
    return true
  })
  return found
}

export function findStack(node: DockNode | null | undefined, id: StackId): DockStack | null {
  const found = findDockNode(node, id)
  return found?.kind === 'stack' ? found : null
}

export function findSplit(node: DockNode | null | undefined, id: SplitId): DockSplit | null {
  const found = findDockNode(node, id)
  return found?.kind === 'split' ? found : null
}

export function stackOfPanel(node: DockNode | null | undefined, panelId: PanelId): DockStack | null {
  let found: DockStack | null = null
  visitDock(node, (n) => {
    if (n.kind !== 'stack' || !n.panels.includes(panelId)) return false
    found = n
    return true
  })
  return found
}

/** The split directly holding `id`, and its index there. */
export function parentOf(
  root: DockNode | null | undefined,
  id: DockNodeId,
): { parent: DockSplit; index: number } | null {
  let found: { parent: DockSplit; index: number } | null = null
  visitDock(root, (n) => {
    if (n.kind !== 'split') return false
    const index = n.children.findIndex((child) => child.id === id)
    if (index === -1) return false
    found = { parent: n, index }
    return true
  })
  return found
}

/** Replace the node `id` with `fn(node)`, sharing every untouched subtree. */
export function mapDockNode(root: DockNode, id: DockNodeId, fn: (node: DockNode) => DockNode): DockNode {
  if (root.id === id) return fn(root)
  if (root.kind === 'stack') return root
  let changed = false
  const children = root.children.map((child) => {
    const next = mapDockNode(child, id, fn)
    if (next !== child) changed = true
    return next
  })
  return changed ? { ...root, children } : root
}

export interface DockRemoval {
  dock: DockNode | null
  /** Splits that collapsed into their one remaining child: old id to the id
   *  of the node that took its place. */
  collapsed: Map<SplitId, DockNodeId>
}

/** Take a panel out of the tree. A stack left empty is removed, a split left
 *  with one child is replaced by that child, and the remaining ratios are
 *  renormalised. A split that ends up inside a split of the same direction
 *  is merged into it, so trees stay canonical. */
export function removeFromDock(root: DockNode, panelId: PanelId): DockRemoval {
  const collapsed = new Map<SplitId, DockNodeId>()
  const walk = (node: DockNode): DockNode | null => {
    if (node.kind === 'stack') {
      if (!node.panels.includes(panelId)) return node
      const panels = node.panels.filter((id) => id !== panelId)
      return panels.length === 0 ? null : { ...node, panels }
    }
    let changed = false
    const children: DockNode[] = []
    const ratios: number[] = []
    node.children.forEach((child, i) => {
      const next = walk(child)
      if (next !== child) changed = true
      if (!next) return
      if (next.kind === 'split' && next.direction === node.direction) {
        collapsed.set(next.id, node.id)
        next.children.forEach((grandchild, j) => {
          children.push(grandchild)
          ratios.push(node.ratios[i] * next.ratios[j])
        })
        return
      }
      children.push(next)
      ratios.push(node.ratios[i])
    })
    if (!changed) return node
    if (children.length === 0) return null
    if (children.length === 1) {
      collapsed.set(node.id, children[0].id)
      return children[0]
    }
    return { ...node, children, ratios: normalizeRatios(ratios) }
  }
  return { dock: walk(root), collapsed }
}

/** Insert a tab into a stack: after `after`, first when `after` is null, and
 *  at the end when `after` is undefined or not in the stack. */
export function insertTab(root: DockNode, stackId: StackId, panelId: PanelId, after?: PanelId | null): DockNode {
  return mapDockNode(root, stackId, (node) => {
    if (node.kind !== 'stack') return node
    const panels = node.panels.filter((id) => id !== panelId)
    const at = after === null ? 0 : after === undefined ? -1 : panels.indexOf(after)
    if (after === null) panels.splice(0, 0, panelId)
    else if (at === -1) panels.push(panelId)
    else panels.splice(at + 1, 0, panelId)
    return { ...node, panels }
  })
}

export function sideDirection(side: SplitSide): DockSplit['direction'] {
  return side === 'left' || side === 'right' ? 'horizontal' : 'vertical'
}

/** Whether splitting `besideId` on `side` creates a split node. It does not
 *  when `besideId` is itself a split in that direction (the new stack joins
 *  it at that end) or its parent is (the new stack becomes a sibling). */
export function splitNeedsNode(root: DockNode, besideId: DockNodeId, side: SplitSide): boolean {
  const direction = sideDirection(side)
  const beside = findDockNode(root, besideId)
  if (beside?.kind === 'split' && beside.direction === direction) return false
  return parentOf(root, besideId)?.parent.direction !== direction
}

/** Put `node` next to `besideId`: left/top before it, right/bottom after it.
 *  Splits never nest in the same direction: a same-direction split gains an
 *  equal sibling (keeps three way splits flat); otherwise `besideId` is
 *  wrapped in a new split `splitId` with equal halves. */
export function splitBeside(
  root: DockNode,
  besideId: DockNodeId,
  side: SplitSide,
  node: DockNode,
  splitId: SplitId,
): DockNode {
  const direction = sideDirection(side)
  const after = side === 'right' || side === 'bottom'
  const insert = (split: DockSplit, at: number): DockSplit => {
    const children = [...split.children]
    children.splice(at, 0, node)
    return { ...split, children, ratios: children.map(() => 1 / children.length) }
  }
  const beside = findDockNode(root, besideId)
  if (beside?.kind === 'split' && beside.direction === direction) {
    return mapDockNode(root, besideId, () => insert(beside, after ? beside.children.length : 0))
  }
  const parent = parentOf(root, besideId)
  if (parent && parent.parent.direction === direction) {
    return mapDockNode(root, parent.parent.id, () => insert(parent.parent, after ? parent.index + 1 : parent.index))
  }
  return mapDockNode(root, besideId, (current) => ({
    kind: 'split',
    id: splitId,
    direction,
    children: after ? [current, node] : [node, current],
    ratios: [0.5, 0.5],
  }))
}

export function setSplitRatios(root: DockNode, splitId: SplitId, ratios: number[]): DockNode {
  return mapDockNode(root, splitId, (node) => node.kind === 'split' ? { ...node, ratios } : node)
}

export function normalizeRatios(ratios: readonly number[]): number[] {
  const total = ratios.reduce((a, b) => a + b, 0)
  return ratios.map((r) => r / total)
}

/** Compares tabs, tree shape, ids and directions, not ratios. Presentation
 *  restore (dock-rules.md) uses it to tell a structural change from a resize. */
export function sameDockStructure(a: DockNode | null, b: DockNode | null): boolean {
  if (!a || !b) return a === b
  if (a.kind !== b.kind || a.id !== b.id) return false
  if (a.kind === 'stack' && b.kind === 'stack') {
    return a.panels.length === b.panels.length && a.panels.every((id, i) => id === b.panels[i])
  }
  if (a.kind === 'split' && b.kind === 'split') {
    return a.direction === b.direction
      && a.children.length === b.children.length
      && a.children.every((child, i) => sameDockStructure(child, b.children[i]))
  }
  return false
}
