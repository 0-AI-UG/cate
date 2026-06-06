// @vitest-environment jsdom
// =============================================================================
// Tests for the per-node dock-layout "live store is the authority, node.dockLayout
// is a save-time projection" refactor (Option B).
//
// Covers:
//   1. getNodeDockLayout prefers the live per-node DockStore over the projection,
//      and falls back to node.dockLayout when no live store is registered.
//   2. Demotion: driving the live store's center layout does NOT mutate the
//      canvas store's node.dockLayout on its own (no sync-back subscription).
//   3. Auto-removal preserved: the kept subscription still removes the node when
//      the live layout becomes null.
//   4. remapNodeDockLayout: panelIds remapped, stack/split ids regenerated,
//      activeIndex + tree shape preserved.
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
import { remapNodeDockLayout } from '../../lib/workspace/session'
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

describe('demotion — no sync-back', () => {
  it('driving the live store does NOT mutate canvas node.dockLayout', () => {
    const canvas = getOrCreateCanvasStoreForPanel(CANVAS)
    const seed = tabs(['A'])
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
          dockLayout: seed,
        } as any,
      },
    } as any)

    const live = makeDockStore(tabs(['A']))
    registerNodeDockStore(CANVAS, NODE, live)

    // Mutate the live store's center layout to [A, B].
    live.setState((s) => ({
      zones: { ...s.zones, center: { ...s.zones.center, layout: tabs(['A', 'B']) } },
    }))

    // The canvas store's projection is unchanged (no subscription writes it).
    expect(canvas.getState().nodes[NODE].dockLayout).toBe(seed)
    // But the resolver reflects the live value.
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

describe('remapNodeDockLayout', () => {
  it('remaps panelIds, regenerates stack ids, preserves activeIndex + shape', () => {
    const layout: DockLayoutNode = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      ratios: [0.5, 0.5],
      children: [
        { type: 'tabs', id: 'stack-1', panelIds: ['old-seed', 'extra-1'], activeIndex: 1 },
        { type: 'tabs', id: 'stack-2', panelIds: ['extra-2'], activeIndex: 0 },
      ],
    }
    const map = new Map<string, string>([['old-seed', 'new-seed']])
    const out = remapNodeDockLayout(layout, map)!

    expect(out.type).toBe('split')
    const split = out as Extract<DockLayoutNode, { type: 'split' }>
    // Split + stack ids regenerated (differ from input).
    expect(split.id).not.toBe('split-1')
    expect(split.direction).toBe('horizontal')
    expect(split.ratios).toEqual([0.5, 0.5])
    expect(split.children).toHaveLength(2)

    const s1 = split.children[0] as Extract<DockLayoutNode, { type: 'tabs' }>
    expect(s1.id).not.toBe('stack-1')
    // Seed remapped; extra panel id (not in map) kept as-is.
    expect(s1.panelIds).toEqual(['new-seed', 'extra-1'])
    expect(s1.activeIndex).toBe(1)

    const s2 = split.children[1] as Extract<DockLayoutNode, { type: 'tabs' }>
    expect(s2.id).not.toBe('stack-2')
    expect(s2.panelIds).toEqual(['extra-2'])
  })

  it('returns null for null/undefined input (legacy migration safety)', () => {
    expect(remapNodeDockLayout(null, new Map())).toBeNull()
    expect(remapNodeDockLayout(undefined, new Map())).toBeNull()
  })
})
