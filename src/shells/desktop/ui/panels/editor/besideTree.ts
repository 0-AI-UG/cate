// Where a file opened from a tree-only Files panel goes: the stack next to
// the tree's in its dock, else a new stack split off to its right. On a
// canvas, next to the tree's node.

import { newId } from '@client/host'
import type { PanelPlacementOptions } from '@panels/framework/contract'
import { isCanvasDock, placementOf, stacksIn, type WorkspaceDocument } from '@workspace/document/contract'

export function besideTree(doc: WorkspaceDocument, treePanelId: string): PanelPlacementOptions {
  const placement = placementOf(doc, treePanelId)
  if (!placement || isCanvasDock(placement.dock)) return { near: treePanelId }
  const stacks = stacksIn(doc, placement.dock)
  const index = stacks.findIndex((stack) => stack.id === placement.stackId)
  const neighbour = stacks[index + 1] ?? stacks[index - 1]
  if (neighbour) return { at: { to: 'stack', dock: placement.dock, stackId: neighbour.id } }
  return { at: { to: 'split', dock: placement.dock, beside: placement.stackId, side: 'right', stackId: newId(), splitId: newId() } }
}
