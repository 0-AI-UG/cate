// The canvas selection is one ordered array plus an `active` flag. The
// active (keyboard focused) node is derived: the lead (last) entry, and only
// while the selection is active. So the drawn set (rings and the halo) and the
// moved set (a group drag moves `selection`) are the same thing.
//
//   []                     nothing selected
//   [A], active false      A selected (ring)
//   [A], active true       A selected and active (halo, keyboard)
//   [A, B, C], active false  three rings, none active
//
// Only single-node operations (click, focusNode, focusAndCenter) activate.

import type { NodeId } from '@workspace/document/contract'

export interface SelectionState {
  selection: readonly NodeId[]
  selectionActive: boolean
}

export function focusedNodeId(s: SelectionState): NodeId | null {
  return s.selectionActive && s.selection.length > 0 ? s.selection[s.selection.length - 1] : null
}

export function isSelected(s: Pick<SelectionState, 'selection'>, id: NodeId): boolean {
  return s.selection.includes(id)
}

/** A press on `id` starts a group move when `id` is part of a real
 *  multi-selection. The node drag and the node's focus guard must agree, or
 *  the press collapses the selection before the drag reads it. */
export function isGroupDragMember(selection: readonly NodeId[], id: NodeId): boolean {
  return selection.length > 1 && selection.includes(id)
}

/** `id` appended as the lead, deduped, the rest in order. */
export function withLead(selection: readonly NodeId[], id: NodeId): NodeId[] {
  const next = selection.filter((x) => x !== id)
  next.push(id)
  return next
}
