// =============================================================================
// Regression tests for canvasStore.addNode dedup-by-panelId invariant.
//
// Bug: addNode does not dedupe by panelId. Multiple add-without-cleanup paths
// (e.g. dragging a panel out and back in before the prior canvas node is torn
// down) can produce two CanvasNodeState entries that both reference the same
// panelId. Deleting one removes the underlying panel and makes the other
// duplicate "disappear" too.
//
// Invariant we want: ONE canvas node per panelId per canvas store, at any time.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { createCanvasStore } from './canvasStore'

describe('canvasStore.addNode panelId dedup invariant', () => {
  it('single addNode produces exactly one node for that panelId', () => {
    const store = createCanvasStore()
    store.getState().addNode('panel-X', 'editor', { x: 0, y: 0 }, { width: 100, height: 80 })

    const nodes = Object.values(store.getState().nodes)
    const matching = nodes.filter((n) => n.panelId === 'panel-X')
    expect(matching).toHaveLength(1)
  })

  it('repeated addNode for the same panelId produces exactly ONE node', () => {
    const store = createCanvasStore()
    store.getState().addNode('panel-X', 'editor', { x: 0, y: 0 }, { width: 100, height: 80 })
    store.getState().addNode('panel-X', 'editor', { x: 200, y: 200 }, { width: 100, height: 80 })

    const nodes = Object.values(store.getState().nodes)
    const matching = nodes.filter((n) => n.panelId === 'panel-X')
    // Today this produces 2; post-fix it should be 1.
    expect(matching).toHaveLength(1)
  })

  it('repeated addNode for the same panelId repositions the existing node', () => {
    const store = createCanvasStore()
    const firstId = store.getState().addNode(
      'panel-X',
      'editor',
      { x: 0, y: 0 },
      { width: 100, height: 80 },
    )
    store.getState().addNode('panel-X', 'editor', { x: 200, y: 200 }, { width: 100, height: 80 })

    // nodeForPanel must still resolve to the original node id (no new node minted).
    expect(store.getState().nodeForPanel('panel-X')).toBe(firstId)

    // And that single node's origin should reflect the second-call coords.
    const node = store.getState().nodes[firstId]
    expect(node).toBeDefined()
    expect(node!.origin).toEqual({ x: 200, y: 200 })
  })

  it('different panelIds remain independent', () => {
    const store = createCanvasStore()
    const idA = store.getState().addNode('panel-A', 'editor', { x: 0, y: 0 }, { width: 100, height: 80 })
    const idB = store.getState().addNode('panel-B', 'editor', { x: 300, y: 300 }, { width: 100, height: 80 })

    expect(idA).not.toBe(idB)
    const nodes = Object.values(store.getState().nodes)
    expect(nodes).toHaveLength(2)
    expect(nodes.some((n) => n.panelId === 'panel-A')).toBe(true)
    expect(nodes.some((n) => n.panelId === 'panel-B')).toBe(true)
  })
})
