// =============================================================================
// selectionModel — the canonical canvas selection is a single ordered array
// (`selection`) plus an `selectionActive` flag. There is no standalone
// "focused node id": the active/keyboard-focused node is *derived* as the lead
// (last) entry of the selection, and only while the selection is activated.
//
// This makes the rendered set (selection rings + the active halo) and the moved
// set (a group drag translates `selection`) the same thing by construction — a
// node can never render as selected/active yet sit outside the moved set.
//
//   selection = []                       → nothing selected, nothing active
//   selection = [A], active = false      → A selected (ring), not active
//   selection = [A], active = true       → A selected + active (halo, keyboard)
//   selection = [A, B, C], active = false → A,B,C selected (rings), none active
//
// A multi-selection is never "activated": only operations that collapse the
// selection to a single node (click, focusNode, focusAndCenter, addNode) set
// `selectionActive`. Pure selection (marquee, selectAll, toggle, Cmd+Arrow)
// leaves it false.
// =============================================================================

import type { CanvasNodeId } from '../../../shared/types'
import type { CanvasStoreState } from './storeTypes'

type SelectionState = Pick<CanvasStoreState, 'selection' | 'selectionActive'>

/** The single active / keyboard-focused node, or null. Derived — never stored.
 *  It's the selection's lead (last) entry, but only while the selection is
 *  activated; a selected-but-not-activated selection has no active node. */
export function focusedNodeId(s: SelectionState): CanvasNodeId | null {
  return s.selectionActive && s.selection.length > 0
    ? s.selection[s.selection.length - 1]
    : null
}

/** Whether `id` is part of the current selection (renders a selection ring). */
export function isSelected(s: Pick<CanvasStoreState, 'selection'>, id: CanvasNodeId): boolean {
  return s.selection.includes(id)
}

/** Whether a left-press on `id` should start a GROUP move (translate the whole
 *  selection) rather than focus/single-drag it: `id` is part of a real
 *  multi-selection. The single source of truth shared by `useGroupNodeDrag`'s
 *  takeover test and CanvasNode's capture-phase focus guard — they must agree,
 *  or the press collapses the selection to one before the group drag reads it
 *  (the "grabbing a selected panel moves only one" bug). */
export function isGroupDragMember(selection: readonly CanvasNodeId[], id: CanvasNodeId): boolean {
  return selection.length > 1 && selection.includes(id)
}

/** Selection with `id` appended as the lead (deduped), preserving the order of
 *  the rest. Used by additive selection so the most-recent stays last. */
export function withLead(selection: readonly CanvasNodeId[], id: CanvasNodeId): CanvasNodeId[] {
  const next = selection.filter((x) => x !== id)
  next.push(id)
  return next
}
