// =============================================================================
// memberGhostRects — group-drag ghost geometry. Pins that a grouped canvas-node
// drag produces ONE ghost rect per other selected member, each offset from the
// anchor ghost by the member's canvas-space start delta (× renderZoom) and
// sized from its live node size. Regression guard for the "only one ghost
// renders for a multi-selection drag" bug.
// =============================================================================

import { describe, it, expect } from 'vitest'
import type { StoreApi } from 'zustand'
import { memberGhostRects } from './Overlay'
import type { DragSource } from './types'
import type { CanvasStore } from '../stores/canvasStore'

// Minimal CanvasStore stub exposing only the `nodes` map memberGhostRects reads.
function fakeCanvasApi(nodes: Record<string, { size: { width: number; height: number } }>): StoreApi<CanvasStore> {
  return {
    getState: () => ({ nodes }),
  } as unknown as StoreApi<CanvasStore>
}

function groupSource(opts: {
  canvasApi: StoreApi<CanvasStore>
  startOrigin?: { x: number; y: number }
  members?: { nodeId: string; startOrigin: { x: number; y: number } }[]
}): DragSource {
  return {
    panelId: 'panel-A',
    origin: {
      kind: 'canvas-node',
      canvasStoreApi: opts.canvasApi,
      nodeId: 'A',
      startOrigin: opts.startOrigin,
      members: opts.members,
    },
  }
}

const anchorRect = { left: 100, top: 50, width: 200, height: 150 }

describe('memberGhostRects', () => {
  it('offsets each member from the anchor by its canvas-space start delta × zoom', () => {
    const api = fakeCanvasApi({
      B: { size: { width: 300, height: 120 } },
      C: { size: { width: 80, height: 80 } },
    })
    const source = groupSource({
      canvasApi: api,
      startOrigin: { x: 0, y: 0 },
      members: [
        { nodeId: 'B', startOrigin: { x: 400, y: 0 } },
        { nodeId: 'C', startOrigin: { x: 0, y: 300 } },
      ],
    })

    const rects = memberGhostRects(source, anchorRect, 1)
    expect(rects).toEqual([
      { key: 'B', left: 100 + 400, top: 50 + 0, width: 300, height: 120 },
      { key: 'C', left: 100 + 0, top: 50 + 300, width: 80, height: 80 },
    ])
  })

  it('scales the offset and size by renderZoom', () => {
    const api = fakeCanvasApi({ B: { size: { width: 200, height: 100 } } })
    const source = groupSource({
      canvasApi: api,
      startOrigin: { x: 0, y: 0 },
      members: [{ nodeId: 'B', startOrigin: { x: 400, y: 200 } }],
    })

    const rects = memberGhostRects(source, anchorRect, 0.5)
    expect(rects).toEqual([
      { key: 'B', left: 100 + 200, top: 50 + 100, width: 100, height: 50 },
    ])
  })

  it('returns [] for a non-grouped canvas-node source (no members)', () => {
    const api = fakeCanvasApi({})
    expect(memberGhostRects(groupSource({ canvasApi: api }), anchorRect, 1)).toEqual([])
  })

  it('skips members whose node has vanished from the store', () => {
    const api = fakeCanvasApi({ B: { size: { width: 100, height: 100 } } })
    const source = groupSource({
      canvasApi: api,
      startOrigin: { x: 0, y: 0 },
      members: [
        { nodeId: 'B', startOrigin: { x: 100, y: 0 } },
        { nodeId: 'GONE', startOrigin: { x: 200, y: 0 } },
      ],
    })
    const rects = memberGhostRects(source, anchorRect, 1)
    expect(rects.map((r) => r.key)).toEqual(['B'])
  })

  it('returns [] for a dock-tab source', () => {
    const source: DragSource = {
      panelId: 'p',
      origin: { kind: 'dock-tab', dockStoreApi: {} as never, stackId: 's', zone: 'center' },
    }
    expect(memberGhostRects(source, anchorRect, 1)).toEqual([])
  })
})
