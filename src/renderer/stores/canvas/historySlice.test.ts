// =============================================================================
// Undo/redo must version selection alongside {nodes}, and restore it
// filtered to live ids — so after an undo/redo, selectedNodeIds can never
// point at nodes that don't exist.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { createCanvasStore } from '../canvasStore'

// Invariant the whole feature exists to guarantee: every selected id is live.
function expectSelectionLive(store: ReturnType<typeof createCanvasStore>) {
  const s = store.getState()
  for (const id of s.selection) expect(s.nodes[id]).toBeDefined()
}

describe('canvas history — selection is versioned and restored filtered to live ids', () => {
  it('undo of a delete restores the deleted node AND its snapshot-time selection (live only)', () => {
    const store = createCanvasStore()
    const a = store.getState().addNode('a', 'editor', { x: 0, y: 0 }, { width: 100, height: 80 })
    const b = store.getState().addNode('b', 'editor', { x: 200, y: 0 }, { width: 100, height: 80 })

    // Select both, then delete only A (deleteSelection deletes the selection, so
    // select just A for the delete but keep B selected first to exercise filtering).
    store.getState().selectNodes([a, b])
    expect([...store.getState().selection].sort()).toEqual([a, b].sort())

    // Snapshot now has selection {a,b}. Narrow selection to A and delete it.
    store.getState().selectNodes([a])
    store.getState().deleteSelection() // pushes history with selection {a}, then removes A
    store.getState().finalizeRemoveNode(a) // flush the exit animation

    expect(store.getState().nodes[a]).toBeUndefined()
    expect(store.getState().selection.length).toBe(0) // delete clears selection

    // Undo: A comes back; selection restored to the snapshot ({a}), and A is live.
    store.getState().undo()
    expect(store.getState().nodes[a]).toBeDefined()
    expect([...store.getState().selection]).toEqual([a])
    expectSelectionLive(store)
  })

  it('never restores a dangling id: snapshot selection {a,b} but b absent → only a survives', () => {
    const store = createCanvasStore()
    const a = store.getState().addNode('a', 'editor', { x: 0, y: 0 }, { width: 100, height: 80 })

    // Hand-craft a history entry whose selection references a node (b) not present
    // in the entry's nodes map — exactly the corruption this feature prevents.
    const entryNodes = { ...store.getState().nodes }
    store.setState({
      history: [
        {
          nodes: entryNodes,
          selection: [a, 'b-deleted'],
          selectionActive: false,
        },
      ],
      future: [],
    })

    store.getState().undo()
    expect([...store.getState().selection]).toEqual([a]) // b-deleted filtered out
    expectSelectionLive(store)
  })

  it('redo re-applies and keeps selection consistent (no dangling ids)', () => {
    const store = createCanvasStore()
    const a = store.getState().addNode('a', 'editor', { x: 0, y: 0 }, { width: 100, height: 80 })

    store.getState().selectNodes([a])
    store.getState().deleteSelection()
    store.getState().finalizeRemoveNode(a)

    store.getState().undo() // A back, selection {a}
    expect(store.getState().nodes[a]).toBeDefined()
    expect([...store.getState().selection]).toEqual([a])

    store.getState().redo() // re-applies the post-delete state (A gone)
    expect(store.getState().nodes[a]).toBeUndefined()
    // Redo restores the post-delete snapshot, whose selection was empty.
    expect(store.getState().selection.length).toBe(0)
    expectSelectionLive(store)
  })

  it('clones selection at push time — mutating the live set in place does not corrupt history', () => {
    const store = createCanvasStore()
    const a = store.getState().addNode('a', 'editor', { x: 0, y: 0 }, { width: 100, height: 80 })
    const b = store.getState().addNode('b', 'editor', { x: 200, y: 0 }, { width: 100, height: 80 })

    store.getState().selectNodes([a])
    store.getState().pushHistory() // snapshot selection {a}
    const snap = store.getState().history[store.getState().history.length - 1]

    // The snapshot must be a distinct array, not the live reference: mutating the
    // current selection in place must not leak into the recorded entry.
    expect(snap.selection).not.toBe(store.getState().selection)
    store.getState().selection.push(b) // mutate live array in place
    expect([...snap.selection]).toEqual([a])

    store.getState().undo()
    expect([...store.getState().selection]).toEqual([a])
    expectSelectionLive(store)
  })

  it('invariant holds across an undo/redo sequence', () => {
    const store = createCanvasStore()
    const a = store.getState().addNode('a', 'editor', { x: 0, y: 0 }, { width: 100, height: 80 })
    const b = store.getState().addNode('b', 'editor', { x: 200, y: 0 }, { width: 100, height: 80 })

    store.getState().selectNodes([a])
    store.getState().deleteSelection()
    store.getState().finalizeRemoveNode(a)
    store.getState().selectNodes([b])
    store.getState().deleteSelection()

    // Walk back and forth; the invariant must hold after every step.
    store.getState().undo(); expectSelectionLive(store)
    store.getState().undo(); expectSelectionLive(store)
    store.getState().redo(); expectSelectionLive(store)
    store.getState().redo(); expectSelectionLive(store)
    store.getState().undo(); expectSelectionLive(store)
  })
})
