// =============================================================================
// selectionModel / canonical-selection invariant.
//
// The canvas selection is one ordered array (`selection`) plus an
// `selectionActive` flag; the active/focused node is DERIVED as the lead of the
// selection. This makes the rendered set (selection rings + the active halo) and
// the moved set (a group drag translates `selection`) the same thing — a node
// can never render as focused/selected yet sit outside the moved set, which was
// the "what's selected vs what moves don't match" bug.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { createCanvasStore } from '../canvasStore'
import { focusedNodeId, isSelected, withLead, isGroupDragMember } from './selectionModel'

function addThree() {
  const store = createCanvasStore()
  const a = store.getState().addNode('a', 'terminal', { x: 0, y: 0 }, { width: 100, height: 80 })
  const b = store.getState().addNode('b', 'terminal', { x: 200, y: 0 }, { width: 100, height: 80 })
  const c = store.getState().addNode('c', 'terminal', { x: 400, y: 0 }, { width: 100, height: 80 })
  return { store, a, b, c }
}

/** The core invariant: the derived focused node is always null or a member of
 *  the selection — never a node outside the moved set. */
function expectInvariant(state: { selection: string[]; selectionActive: boolean }) {
  const f = focusedNodeId(state)
  if (f !== null) expect(state.selection).toContain(f)
}

describe('focusedNodeId derivation', () => {
  it('is the lead (last) of the selection only while activated', () => {
    expect(focusedNodeId({ selection: [], selectionActive: false })).toBeNull()
    expect(focusedNodeId({ selection: ['x'], selectionActive: false })).toBeNull()
    expect(focusedNodeId({ selection: ['x'], selectionActive: true })).toBe('x')
    expect(focusedNodeId({ selection: ['x', 'y'], selectionActive: true })).toBe('y')
  })
})

describe('isGroupDragMember', () => {
  // This predicate is the contract between CanvasNode's capture-phase focus
  // guard (which must BAIL when true) and useGroupNodeDrag's takeover (which
  // must FIRE when true). If they disagree, a press on a selected panel's title
  // bar focuses+collapses to that one node before the group drag reads the
  // selection — so only the grabbed panel moves.
  it('is true only for a member of a real multi-selection', () => {
    expect(isGroupDragMember(['a', 'b'], 'a')).toBe(true)
    expect(isGroupDragMember(['a', 'b', 'c'], 'c')).toBe(true)
  })
  it('is false for a single-node selection (plain focus/drag, no group)', () => {
    expect(isGroupDragMember(['a'], 'a')).toBe(false)
  })
  it('is false when the grabbed node is outside the selection', () => {
    expect(isGroupDragMember(['a', 'b'], 'c')).toBe(false)
  })
  it('is false for an empty selection', () => {
    expect(isGroupDragMember([], 'a')).toBe(false)
  })
})

describe('withLead', () => {
  it('appends as lead, de-duping and preserving the rest in order', () => {
    expect(withLead(['a', 'b', 'c'], 'b')).toEqual(['a', 'c', 'b'])
    expect(withLead(['a'], 'z')).toEqual(['a', 'z'])
  })
})

describe('canonical selection invariant', () => {
  it('focusNode collapses to a single active selection (focused is in selection)', () => {
    const { store, b } = addThree()
    store.getState().focusNode(b)
    const s = store.getState()
    expect(s.selection).toEqual([b])
    expect(focusedNodeId(s)).toBe(b)
    expectInvariant(s)
  })

  it('a marquee-style multi-selection has NO active node — glow set == selection == moved set', () => {
    const { store, a, b } = addThree()
    store.getState().selectNodes([a, b])
    const s = store.getState()
    expect(s.selection).toEqual([a, b])
    // No focused node → every selected node renders the same (ring), and the
    // group drag (which moves `selection`) moves exactly the glowing set.
    expect(focusedNodeId(s)).toBeNull()
    expect(isSelected(s, a)).toBe(true)
    expect(isSelected(s, b)).toBe(true)
    expectInvariant(s)
  })

  it('the old divergence is gone: focusing then marquee-selecting elsewhere drops the stale focus', () => {
    const { store, a, b, c } = addThree()
    // Activate A (it would have rendered a halo under the old model)...
    store.getState().focusNode(a)
    expect(focusedNodeId(store.getState())).toBe(a)
    // ...then marquee a different set. Previously A kept its halo while sitting
    // outside the selection (looked selected, didn't move). Now there is no
    // focused node outside the moved set.
    store.getState().selectNodes([b, c])
    const s = store.getState()
    expect(focusedNodeId(s)).toBeNull()
    expect(isSelected(s, a)).toBe(false)
    expect(s.selection).toEqual([b, c])
    expectInvariant(s)
  })

  it('removing the active node deactivates and drops it from the selection', () => {
    const { store, a } = addThree()
    store.getState().focusNode(a)
    store.getState().removeNode(a)
    const s = store.getState()
    expect(s.selection).not.toContain(a)
    expect(focusedNodeId(s)).toBeNull()
    expectInvariant(s)
  })

  it('toggle builds a multi-selection with no active lead', () => {
    const { store, a, b } = addThree()
    store.getState().focusNode(a)
    store.getState().toggleNodeSelection(b)
    const s = store.getState()
    expect(new Set(s.selection)).toEqual(new Set([a, b]))
    expect(focusedNodeId(s)).toBeNull()
    expectInvariant(s)
  })
})

// =============================================================================
// selectNodes — replace vs additive, dedup, and the always-deactivate rule.
// =============================================================================

describe('selectNodes', () => {
  it('non-additive replaces the selection, de-duping while preserving order', () => {
    const { store, a, b, c } = addThree()
    store.getState().selectNodes([c, a])
    expect(store.getState().selection).toEqual([c, a])
    // A second non-additive call REPLACES (does not append).
    store.getState().selectNodes([b, b, a])
    expect(store.getState().selection).toEqual([b, a]) // duplicate b collapsed
  })

  it('additive appends new ids as the lead and re-leads an already-selected id', () => {
    const { store, a, b, c } = addThree()
    store.getState().selectNodes([a, b], false)
    expect(store.getState().selection).toEqual([a, b])
    // Additive adds c as the new lead.
    store.getState().selectNodes([c], true)
    expect(store.getState().selection).toEqual([a, b, c])
    // Additively re-selecting an existing member moves it to the lead (withLead).
    store.getState().selectNodes([a], true)
    expect(store.getState().selection).toEqual([b, c, a])
  })

  it('ALWAYS leaves selectionActive false, even when re-selecting the active node', () => {
    const { store, a } = addThree()
    store.getState().focusNode(a)
    expect(store.getState().selectionActive).toBe(true)
    // A pure selection of the very node that was active must still deactivate.
    store.getState().selectNodes([a])
    expect(store.getState().selectionActive).toBe(false)
    expect(focusedNodeId(store.getState())).toBeNull()
  })
})

// =============================================================================
// selectAll / clearSelection — bulk operations and their active flag.
// =============================================================================

describe('selectAll & clearSelection', () => {
  it('selectAll selects every node with no active lead', () => {
    const { store, a, b, c } = addThree()
    store.getState().focusNode(a) // start activated
    store.getState().selectAll()
    const s = store.getState()
    expect(new Set(s.selection)).toEqual(new Set([a, b, c]))
    expect(s.selectionActive).toBe(false)
    expect(focusedNodeId(s)).toBeNull()
    expectInvariant(s)
  })

  it('clearSelection empties the selection and deactivates', () => {
    const { store, a, b } = addThree()
    store.getState().selectNodes([a, b])
    store.getState().clearSelection()
    const s = store.getState()
    expect(s.selection).toEqual([])
    expect(s.selectionActive).toBe(false)
    expect(focusedNodeId(s)).toBeNull()
  })
})

// =============================================================================
// toggleNodeSelection — add/remove and the deactivate rule.
// =============================================================================

describe('toggleNodeSelection', () => {
  it('toggles a node out again (second toggle removes it)', () => {
    const { store, a, b } = addThree()
    store.getState().selectNodes([a])
    store.getState().toggleNodeSelection(b) // add
    expect(new Set(store.getState().selection)).toEqual(new Set([a, b]))
    store.getState().toggleNodeSelection(b) // remove
    expect(store.getState().selection).toEqual([a])
    expect(store.getState().selectionActive).toBe(false)
  })
})

// =============================================================================
// unfocus — drops the active flag but KEEPS the selection rings.
// =============================================================================

describe('unfocus', () => {
  it('deactivates the lead without touching the selection', () => {
    const { store, a } = addThree()
    store.getState().focusNode(a)
    expect(focusedNodeId(store.getState())).toBe(a)
    store.getState().unfocus()
    const s = store.getState()
    expect(s.selection).toEqual([a]) // ring stays
    expect(s.selectionActive).toBe(false)
    expect(focusedNodeId(s)).toBeNull()
    expectInvariant(s)
  })

  it('keeps a whole multi-selection visible after unfocus', () => {
    const { store, a, b, c } = addThree()
    store.getState().selectNodes([a, b, c])
    store.getState().unfocus()
    expect(store.getState().selection).toEqual([a, b, c])
  })
})

// =============================================================================
// The activating actions — focusNode / focusAndCenter / toggleMaximize / addNode
// (existing-node branch) all collapse to [id] + active and bump zOrder/epoch.
// =============================================================================

describe('activating actions collapse to a single active selection', () => {
  it('focusAndCenter collapses to [id], activates, bumps zOrder + focusEpoch', () => {
    const { store, a, c } = addThree()
    store.getState().setContainerSize({ width: 800, height: 600 })
    store.getState().selectNodes([a, c]) // a multi-selection to be collapsed
    const z0 = store.getState().nodes[c].zOrder
    const e0 = store.getState().focusEpoch
    store.getState().focusAndCenter(c)
    const s = store.getState()
    expect(s.selection).toEqual([c])
    expect(focusedNodeId(s)).toBe(c)
    expect(s.nodes[c].zOrder).toBeGreaterThan(z0)
    expect(s.focusEpoch).toBe(e0 + 1)
    expectInvariant(s)
  })

  it('toggleMaximize collapses to [id] + active', () => {
    const { store, a, b } = addThree()
    store.getState().setContainerSize({ width: 800, height: 600 })
    store.getState().selectNodes([a, b])
    store.getState().toggleMaximize(b, { width: 800, height: 600 })
    const s = store.getState()
    expect(s.selection).toEqual([b])
    expect(focusedNodeId(s)).toBe(b)
    expectInvariant(s)
  })

  it("addNode's existing-node branch collapses to that node + active", () => {
    const { store, a } = addThree()
    store.getState().selectNodes([a]) // deactivated
    expect(store.getState().selectionActive).toBe(false)
    // Re-adding the SAME panelId hits the dedupe branch → focuses the node.
    const again = store.getState().addNode('a', 'terminal', { x: 10, y: 10 }, { width: 100, height: 80 })
    expect(again).toBe(a)
    const s = store.getState()
    expect(s.selection).toEqual([a])
    expect(focusedNodeId(s)).toBe(a)
    expectInvariant(s)
  })

  it('fresh addNode (new panelId) does NOT activate or select the new node', () => {
    const { store, a } = addThree()
    store.getState().focusNode(a)
    const created = store.getState().addNode('brand-new', 'terminal', { x: 999, y: 999 }, { width: 100, height: 80 })
    const s = store.getState()
    // The freshly added node is not auto-selected; the prior active node remains.
    expect(s.selection).toEqual([a])
    expect(s.selection).not.toContain(created)
  })
})

// =============================================================================
// Single-node move vs group move — the store-level moveNode only ever touches
// the one node it's given (group drag is what fans a delta out across the
// selection; see useGroupNodeDrag tests).
// =============================================================================

describe('moveNode moves only the grabbed node', () => {
  it('translating one node leaves every other node put', () => {
    const { store, a, b, c } = addThree()
    store.getState().selectNodes([a, b, c]) // all selected...
    const bOrigin = { ...store.getState().nodes[b].origin }
    const cOrigin = { ...store.getState().nodes[c].origin }
    // ...but a single moveNode must not drag the rest along.
    store.getState().moveNode(a, { x: 1000, y: 1000 })
    expect(store.getState().nodes[a].origin).toEqual({ x: 1000, y: 1000 })
    expect(store.getState().nodes[b].origin).toEqual(bOrigin)
    expect(store.getState().nodes[c].origin).toEqual(cOrigin)
  })
})

// =============================================================================
// removeNode / finalizeRemoveNode — selection reconciliation.
// =============================================================================

describe('removeNode / finalizeRemoveNode reconcile the selection', () => {
  it('removeNode drops the id from a multi-selection and keeps the rest active flag', () => {
    const { store, a, b, c } = addThree()
    // Multi-selection, deactivated. Removing a non-lead member just drops it.
    store.getState().selectNodes([a, b, c])
    store.getState().removeNode(b)
    const s = store.getState()
    expect(s.selection).toEqual([a, c])
    expect(s.selectionActive).toBe(false) // unchanged (b wasn't the active lead)
    expectInvariant(s)
  })

  it('removing a non-active node while another is active leaves the active one focused', () => {
    const { store, a, b } = addThree()
    store.getState().focusNode(a) // a is the active lead
    store.getState().removeNode(b) // b isn't even selected
    const s = store.getState()
    expect(focusedNodeId(s)).toBe(a)
    expect(s.selectionActive).toBe(true)
  })

  it('finalizeRemoveNode defensively scrubs a lingering id from the selection', () => {
    const { store, a, b } = addThree()
    store.getState().selectNodes([a, b])
    // Simulate the id surviving in the selection past removeNode (defensive path).
    store.getState().finalizeRemoveNode(a)
    expect(store.getState().selection).not.toContain(a)
    expect(store.getState().nodes[a]).toBeUndefined()
    expectInvariant(store.getState())
  })

  it('finalizeRemoveNode is a no-op for an id that was never selected', () => {
    const { store, a, b, c } = addThree()
    store.getState().selectNodes([a, b])
    const before = store.getState().selection
    store.getState().finalizeRemoveNode(c) // c not selected
    // Selection array reference is preserved (no needless rewrite).
    expect(store.getState().selection).toBe(before)
  })
})

// =============================================================================
// navigateSelect vs navigateDirection — select-without-activate vs activate.
// (Spatial nearest-node math is covered in canvasStore.test.ts; here we pin the
// activation contract specifically.)
// =============================================================================

describe('navigateSelect vs navigateDirection — activation contract', () => {
  function setupRow() {
    const store = createCanvasStore()
    store.getState().setContainerSize({ width: 1000, height: 800 })
    const c = store.getState().addNode('c', 'editor', { x: 0, y: 0 }, { width: 100, height: 80 })
    const r = store.getState().addNode('r', 'editor', { x: 400, y: 0 }, { width: 100, height: 80 })
    return { store, c, r }
  }

  it('navigateSelect selects the target WITHOUT activating it (focusedNodeId stays null)', () => {
    const { store, c, r } = setupRow()
    store.getState().selectNodes([c])
    store.getState().navigateSelect('right')
    const s = store.getState()
    expect(s.selection).toEqual([r])
    expect(s.selectionActive).toBe(false)
    expect(focusedNodeId(s)).toBeNull()
    expect(s.suppressAutoFocus).toBe(true)
    expectInvariant(s)
  })

  it('navigateDirection ACTIVATES the target (focusedNodeId === target)', () => {
    const { store, c, r } = setupRow()
    store.getState().focusNode(c)
    store.getState().navigateDirection('right')
    const s = store.getState()
    expect(s.selection).toEqual([r])
    expect(focusedNodeId(s)).toBe(r)
    expect(s.selectionActive).toBe(true)
    expectInvariant(s)
  })
})

// =============================================================================
// undo/redo round-trips selectionActive alongside selection.
// (historySlice.test.ts covers selection-id filtering; this pins the active flag
// specifically, which is the new field the history entry must carry.)
// =============================================================================

describe('undo/redo round-trips selectionActive', () => {
  it('restores both an active single-selection and a deactivated multi-selection', () => {
    const { store, a, b } = addThree()
    // State 1: A active (a single-node activation). pushHistory snapshots it.
    store.getState().focusNode(a)
    expect(focusedNodeId(store.getState())).toBe(a)
    store.getState().pushHistory()

    // State 2: deactivated multi-selection [a,b].
    store.getState().selectNodes([a, b])
    expect(store.getState().selectionActive).toBe(false)

    // Undo → back to the active single-selection.
    store.getState().undo()
    let s = store.getState()
    expect(s.selection).toEqual([a])
    expect(s.selectionActive).toBe(true)
    expect(focusedNodeId(s)).toBe(a)

    // Redo → forward to the deactivated multi-selection.
    store.getState().redo()
    s = store.getState()
    expect(new Set(s.selection)).toEqual(new Set([a, b]))
    expect(s.selectionActive).toBe(false)
    expect(focusedNodeId(s)).toBeNull()
    expectInvariant(s)
  })
})
