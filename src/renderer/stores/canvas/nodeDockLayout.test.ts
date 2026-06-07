// @vitest-environment jsdom
// =============================================================================
// Tests for the per-node dock-layout refactor: the live per-node DockStore is
// the runtime editing authority; canvasStore.node.dockLayout is its canonical
// PERSISTED projection, kept in lock-step so the two never drift.
//
// Covers:
//   1. getNodeDockLayout prefers the live per-node DockStore over the projection,
//      and falls back to node.dockLayout when no live store is registered.
//   2. Sync-back: the CanvasPanel subscription mirrors live center-layout changes
//      into canvasStore.node.dockLayout (so history/off-screen reads stay fresh).
//   3. Auto-removal: the same subscription removes the node when the live layout
//      becomes null.
// =============================================================================

import { afterEach, describe, expect, it } from 'vitest'
import type { DockLayoutNode } from '../../../shared/types'
import { createDockStore, type DockStore } from '../dockStore'
import {
  registerNodeDockStore,
  unregisterNodeDockStore,
  getLiveNodeDockLayout,
} from '../../panels/nodeDockRegistry'
import { getNodeDockLayout } from '../../lib/workspace/canvasAccess'
import { getOrCreateCanvasStoreForPanel, releaseCanvasStoreForPanel } from '../canvasStore'
import type { StoreApi } from 'zustand'

const CANVAS = 'canvas-panel-ndl'
const NODE = 'node-ndl'

function makeDockStore(layout: DockLayoutNode | null): StoreApi<DockStore> {
  return createDockStore({
    zones: {
      left: { position: 'left', visible: false, size: 260, layout: null },
      right: { position: 'right', visible: false, size: 260, layout: null },
      bottom: { position: 'bottom', visible: false, size: 240, layout: null },
      center: { position: 'center', visible: true, size: 0, layout },
    },
    locations: {},
  })
}

function tabs(panelIds: string[], activeIndex = 0): DockLayoutNode {
  return { type: 'tabs', id: `stack-${panelIds.join('-')}`, panelIds, activeIndex }
}

afterEach(() => {
  unregisterNodeDockStore(CANVAS, NODE)
  releaseCanvasStoreForPanel(CANVAS)
})

describe('getNodeDockLayout', () => {
  it('prefers the live per-node DockStore over node.dockLayout', () => {
    // Projection (canvas store) has a single-tab seed...
    const canvas = getOrCreateCanvasStoreForPanel(CANVAS)
    canvas.setState({
      nodes: {
        [NODE]: {
          id: NODE,
          panelId: 'A',
          origin: { x: 0, y: 0 },
          size: { width: 100, height: 100 },
          zOrder: 0,
          creationIndex: 0,
          animationState: 'idle',
          dockLayout: tabs(['A']),
        } as any,
      },
    } as any)

    // ...but the live store has two tabs [A, B].
    const live = makeDockStore(tabs(['A', 'B']))
    registerNodeDockStore(CANVAS, NODE, live)

    const resolved = getNodeDockLayout(CANVAS, NODE)
    expect(resolved).not.toBeNull()
    expect(resolved!.type).toBe('tabs')
    expect((resolved as any).panelIds).toEqual(['A', 'B'])

    // getLiveNodeDockLayout returns undefined when not registered (distinct from
    // null = mounted but empty).
    unregisterNodeDockStore(CANVAS, NODE)
    expect(getLiveNodeDockLayout(CANVAS, NODE)).toBeUndefined()

    // Falls back to the projection once the live store is gone.
    const fallback = getNodeDockLayout(CANVAS, NODE)
    expect((fallback as any).panelIds).toEqual(['A'])
  })
})

describe('sync-back keeps the projection current', () => {
  it('mirrors live center-layout changes into canvas node.dockLayout', () => {
    const canvas = getOrCreateCanvasStoreForPanel(CANVAS)
    canvas.setState({
      nodes: {
        [NODE]: {
          id: NODE,
          panelId: 'A',
          origin: { x: 0, y: 0 },
          size: { width: 100, height: 100 },
          zOrder: 0,
          creationIndex: 0,
          animationState: 'idle',
          dockLayout: tabs(['A']),
        } as any,
      },
    } as any)

    const live = makeDockStore(tabs(['A']))
    registerNodeDockStore(CANVAS, NODE, live)

    // Reproduce the CanvasPanel subscription: mirror non-null changes into the
    // projection, remove the node on null.
    const unsubscribe = live.subscribe((state, prev) => {
      const layout = state.zones.center.layout
      if (layout === prev.zones.center.layout) return
      if (layout === null) canvas.getState().removeNode(NODE)
      else canvas.getState().setNodeDockLayout(NODE, layout)
    })

    // Mutate the live store's center layout to [A, B].
    live.setState((s) => ({
      zones: { ...s.zones, center: { ...s.zones.center, layout: tabs(['A', 'B']) } },
    }))
    unsubscribe()

    // The projection now matches the live layout — no drift.
    expect((canvas.getState().nodes[NODE].dockLayout as any).panelIds).toEqual(['A', 'B'])
    // And the resolver agrees (live while mounted, projection otherwise).
    expect((getNodeDockLayout(CANVAS, NODE) as any).panelIds).toEqual(['A', 'B'])
    unregisterNodeDockStore(CANVAS, NODE)
    expect((getNodeDockLayout(CANVAS, NODE) as any).panelIds).toEqual(['A', 'B'])
  })
})

describe('auto-removal subscription (the kept behavior)', () => {
  it('removes the node when the live layout becomes null', () => {
    // Reproduce the subscription kept in CanvasPanel: layout === null -> removeNode.
    let removed: string | null = null
    const canvasApi = {
      getState: () => ({ removeNode: (id: string) => { removed = id } }),
    } as any

    const live = makeDockStore(tabs(['A']))
    const unsubscribe = live.subscribe((state, prev) => {
      const layout = state.zones.center.layout
      const prevLayout = prev.zones.center.layout
      if (layout === prevLayout) return
      if (layout === null) canvasApi.getState().removeNode(NODE)
    })

    // Empty the center layout.
    live.setState((s) => ({
      zones: { ...s.zones, center: { ...s.zones.center, layout: null } },
    }))
    unsubscribe()

    expect(removed).toBe(NODE)
  })

  it('does NOT remove the node for a non-null layout change', () => {
    let removed: string | null = null
    const live = makeDockStore(tabs(['A']))
    const unsubscribe = live.subscribe((state, prev) => {
      const layout = state.zones.center.layout
      const prevLayout = prev.zones.center.layout
      if (layout === prevLayout) return
      if (layout === null) removed = NODE
    })
    live.setState((s) => ({
      zones: { ...s.zones, center: { ...s.zones.center, layout: tabs(['A', 'B']) } },
    }))
    unsubscribe()
    expect(removed).toBeNull()
  })
})
