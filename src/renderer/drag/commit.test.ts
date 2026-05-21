import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StoreApi } from 'zustand'

// --- Mocks (must be hoisted before importing commit.ts) -----------------------

const findZoneForStackMock = vi.fn<(zones: unknown, stackId: string) => string | null>()
vi.mock('../stores/dockTreeUtils', () => ({
  findZoneForStack: (zones: unknown, stackId: string) => findZoneForStackMock(zones, stackId),
}))

const findCanvasStoreForNodeMock = vi.fn<(nodeId: string) => unknown>()
vi.mock('./session', () => ({
  getDefaultSession: () => ({
    getCanvasStoreForNode: (nodeId: string) => findCanvasStoreForNodeMock(nodeId),
    reconcileCanvasStoreForNode: (nodeId: string, caller: unknown) => {
      const session = findCanvasStoreForNodeMock(nodeId)
      return session ?? caller ?? null
    },
  }),
}))

// -----------------------------------------------------------------------------

import { commitDrop, type CommitContext } from './commit'
import type { DragSource, DropTarget } from './types'
import type { CanvasStore } from '../stores/canvasStore'
import type { DockStore } from '../stores/dockStore'
import type { PanelTransferSnapshot, PanelType } from '../../shared/types'

// -----------------------------------------------------------------------------
// Builders
// -----------------------------------------------------------------------------

interface MockCanvas {
  store: StoreApi<CanvasStore>
  state: ReturnType<typeof makeMockCanvasState>
}

function makeMockCanvasState() {
  return {
    nodes: {} as Record<
      string,
      { id: string; origin: { x: number; y: number }; size: { width: number; height: number }; regionId?: string }
    >,
    regions: {} as Record<
      string,
      { id: string; origin: { x: number; y: number }; size: { width: number; height: number } }
    >,
    moveNode: vi.fn((_id: string, _origin: { x: number; y: number }) => {
      // Re-bound below to mutate state.nodes.
    }),
    addNode: vi.fn(
      (panelId: string, _type: PanelType, _origin: { x: number; y: number }, _size: { width: number; height: number }) =>
        `node-from-${panelId}`,
    ),
    resizeNode: vi.fn(),
    focusNode: vi.fn(),
    finalizeRemoveNode: vi.fn(),
    setNodeRegion: vi.fn(),
  }
}

function createMockCanvasStore(): MockCanvas {
  const state = makeMockCanvasState()
  // Re-bind moveNode to mutate local node entries (for region containment).
  state.moveNode = vi.fn((id: string, origin: { x: number; y: number }) => {
    if (state.nodes[id]) state.nodes[id].origin = origin
  })
  state.setNodeRegion = vi.fn((id: string, regionId?: string) => {
    if (state.nodes[id]) state.nodes[id].regionId = regionId
  })
  const store = {
    getState() {
      return state as unknown as CanvasStore
    },
    setState() {},
    subscribe() {
      return () => {}
    },
    destroy() {},
  } as unknown as StoreApi<CanvasStore>
  return { store, state }
}

interface MockDock {
  store: StoreApi<DockStore>
  state: {
    undockPanel: ReturnType<typeof vi.fn>
    dockPanel: ReturnType<typeof vi.fn>
    zones: unknown
  }
}

function createMockDockStore(): MockDock {
  const state = {
    undockPanel: vi.fn(),
    dockPanel: vi.fn(),
    zones: {} as unknown,
  }
  const store = {
    getState() {
      return state as unknown as DockStore
    },
    setState() {},
    subscribe() {
      return () => {}
    },
    destroy() {},
  } as unknown as StoreApi<DockStore>
  return { store, state }
}

const panel = { id: 'panel-1', type: 'editor' as PanelType, title: 'Test' }

function defaultCtx(over: Partial<CommitContext> = {}): CommitContext {
  return {
    crossWindowResolve: vi.fn(async () => ({ claimed: false })),
    crossWindowCancel: vi.fn(),
    dragDetach: vi.fn(async () => 99),
    buildSnapshot: vi.fn(() => ({
      panel: { id: 'panel-1', type: 'editor', title: 'Test' },
      geometry: { origin: { x: 0, y: 0 }, size: { width: 320, height: 200 } },
      sourceLocation: { kind: 'canvas' },
    } as unknown as PanelTransferSnapshot)),
    workspaceId: 'ws-1',
    onRemovedFromCanvas: vi.fn(),
    ...over,
  }
}

beforeEach(() => {
  findZoneForStackMock.mockReset()
  findZoneForStackMock.mockReturnValue('left')
  findCanvasStoreForNodeMock.mockReset()
  findCanvasStoreForNodeMock.mockReturnValue(null)
})

// -----------------------------------------------------------------------------
// canvas-reposition
// -----------------------------------------------------------------------------

describe('commitDrop — canvas-reposition', () => {
  it('calls moveNode(nodeId, origin) and runs region containment', async () => {
    const c = createMockCanvasStore()
    c.state.nodes['node-1'] = {
      id: 'node-1',
      origin: { x: 0, y: 0 },
      size: { width: 100, height: 100 },
    }
    c.state.regions['region-1'] = {
      id: 'region-1',
      origin: { x: 90, y: 90 },
      size: { width: 200, height: 200 },
    }
    const source: DragSource = {
      panelId: 'panel-1',
      origin: { kind: 'canvas-node', canvasStoreApi: c.store, nodeId: 'node-1' },
    }
    const target: DropTarget = {
      kind: 'canvas-reposition',
      canvasStoreApi: c.store,
      nodeId: 'node-1',
      origin: { x: 100, y: 100 },
    }
    await commitDrop(source, target, panel, defaultCtx())
    expect(c.state.moveNode).toHaveBeenCalledWith('node-1', { x: 100, y: 100 })
    // Region overlap: node at (100,100) size 100×100 covers (100..200, 100..200),
    // region is (90..290, 90..290). Overlap = 100×100 = 10000 = 100% of node.
    expect(c.state.setNodeRegion).toHaveBeenCalledWith('node-1', 'region-1')
  })

  it('does not assign a region when overlap <= 50%', async () => {
    const c = createMockCanvasStore()
    c.state.nodes['node-1'] = {
      id: 'node-1',
      origin: { x: 0, y: 0 },
      size: { width: 100, height: 100 },
    }
    c.state.regions['region-1'] = {
      id: 'region-1',
      origin: { x: 80, y: 80 },
      size: { width: 100, height: 100 },
    }
    const source: DragSource = {
      panelId: 'panel-1',
      origin: { kind: 'canvas-node', canvasStoreApi: c.store, nodeId: 'node-1' },
    }
    const target: DropTarget = {
      kind: 'canvas-reposition',
      canvasStoreApi: c.store,
      nodeId: 'node-1',
      origin: { x: 0, y: 0 },
    }
    await commitDrop(source, target, panel, defaultCtx())
    // Overlap = 20×20 = 400; node area = 10000; ratio = 4% — no region change.
    // setNodeRegion is only called when bestRegion !== current regionId,
    // and current is undefined → bestRegion is undefined → no call.
    expect(c.state.setNodeRegion).not.toHaveBeenCalled()
  })
})

// -----------------------------------------------------------------------------
// canvas-add
// -----------------------------------------------------------------------------

describe('commitDrop — canvas-add from dock-tab', () => {
  it('undocks from source, then addNode + resizeNode + focusNode on target', async () => {
    const dock = createMockDockStore()
    const canvas = createMockCanvasStore()
    const source: DragSource = {
      panelId: 'panel-1',
      origin: { kind: 'dock-tab', dockStoreApi: dock.store, zone: 'left' as never, stackId: 'stack-1' },
    }
    const target: DropTarget = {
      kind: 'canvas-add',
      canvasStoreApi: canvas.store,
      origin: { x: 10, y: 20 },
      size: { width: 300, height: 200 },
    }
    const ctx = defaultCtx()
    await commitDrop(source, target, panel, ctx)
    expect(dock.state.undockPanel).toHaveBeenCalledWith('panel-1')
    expect(canvas.state.addNode).toHaveBeenCalledWith(
      'panel-1',
      'editor',
      { x: 10, y: 20 },
      { width: 300, height: 200 },
    )
    expect(canvas.state.resizeNode).toHaveBeenCalledWith(
      'node-from-panel-1',
      { width: 300, height: 200 },
    )
    expect(canvas.state.focusNode).toHaveBeenCalledWith('node-from-panel-1')
    expect(ctx.onRemovedFromCanvas).not.toHaveBeenCalled()
  })
})

describe('commitDrop — canvas-add from canvas-node', () => {
  it('finalizeRemoveNode on source canvas, then add+resize+focus on target', async () => {
    const srcCanvas = createMockCanvasStore()
    const tgtCanvas = createMockCanvasStore()
    findCanvasStoreForNodeMock.mockReturnValue(srcCanvas.store)
    const source: DragSource = {
      panelId: 'panel-1',
      origin: { kind: 'canvas-node', canvasStoreApi: srcCanvas.store, nodeId: 'node-S' },
    }
    const target: DropTarget = {
      kind: 'canvas-add',
      canvasStoreApi: tgtCanvas.store,
      origin: { x: 0, y: 0 },
      size: { width: 320, height: 200 },
    }
    const ctx = defaultCtx()
    await commitDrop(source, target, panel, ctx)
    expect(srcCanvas.state.finalizeRemoveNode).toHaveBeenCalledWith('node-S')
    expect(tgtCanvas.state.addNode).toHaveBeenCalled()
    expect(tgtCanvas.state.resizeNode).toHaveBeenCalled()
    expect(tgtCanvas.state.focusNode).toHaveBeenCalled()
    expect(ctx.onRemovedFromCanvas).not.toHaveBeenCalled()
  })
})

// -----------------------------------------------------------------------------
// dock-zone / dock-tab / dock-split
// -----------------------------------------------------------------------------

describe('commitDrop — dock-zone', () => {
  it('canvas-node source: removes from canvas, then dockPanel(zone)', async () => {
    const srcCanvas = createMockCanvasStore()
    findCanvasStoreForNodeMock.mockReturnValue(srcCanvas.store)
    const tgtDock = createMockDockStore()
    const source: DragSource = {
      panelId: 'panel-1',
      origin: { kind: 'canvas-node', canvasStoreApi: srcCanvas.store, nodeId: 'node-S' },
    }
    const target: DropTarget = {
      kind: 'dock-zone',
      dockStoreApi: tgtDock.store,
      zone: 'left' as never,
    }
    await commitDrop(source, target, panel, defaultCtx())
    expect(srcCanvas.state.finalizeRemoveNode).toHaveBeenCalledWith('node-S')
    expect(tgtDock.state.dockPanel).toHaveBeenCalledWith('panel-1', 'left')
  })

  it('panel-window source: no-op (dock-target inside its own window is impossible)', async () => {
    const tgtDock = createMockDockStore()
    const source: DragSource = {
      panelId: 'panel-1',
      origin: { kind: 'panel-window' },
    }
    const target: DropTarget = {
      kind: 'dock-zone',
      dockStoreApi: tgtDock.store,
      zone: 'left' as never,
    }
    await commitDrop(source, target, panel, defaultCtx())
    expect(tgtDock.state.dockPanel).not.toHaveBeenCalled()
  })
})

describe('commitDrop — dock-tab', () => {
  it('dock-tab source: undock from source, then dockPanel(zone, {type:tab})', async () => {
    const srcDock = createMockDockStore()
    const tgtDock = createMockDockStore()
    findZoneForStackMock.mockReturnValue('right')
    const source: DragSource = {
      panelId: 'panel-1',
      origin: { kind: 'dock-tab', dockStoreApi: srcDock.store, zone: 'left' as never, stackId: 'stack-S' },
    }
    const target: DropTarget = {
      kind: 'dock-tab',
      dockStoreApi: tgtDock.store,
      stackId: 'stack-T',
    }
    await commitDrop(source, target, panel, defaultCtx())
    expect(srcDock.state.undockPanel).toHaveBeenCalledWith('panel-1')
    expect(tgtDock.state.dockPanel).toHaveBeenCalledWith('panel-1', 'right', {
      type: 'tab',
      stackId: 'stack-T',
    })
  })

  it('aborts (no source mutation) when the target stack has vanished', async () => {
    const srcDock = createMockDockStore()
    const tgtDock = createMockDockStore()
    findZoneForStackMock.mockReturnValue(null)
    const source: DragSource = {
      panelId: 'panel-1',
      origin: { kind: 'dock-tab', dockStoreApi: srcDock.store, zone: 'left' as never, stackId: 'stack-S' },
    }
    const target: DropTarget = {
      kind: 'dock-tab',
      dockStoreApi: tgtDock.store,
      stackId: 'stack-gone',
    }
    await commitDrop(source, target, panel, defaultCtx())
    expect(srcDock.state.undockPanel).not.toHaveBeenCalled()
    expect(tgtDock.state.dockPanel).not.toHaveBeenCalled()
  })
})

describe('commitDrop — dock-split', () => {
  it('canvas-node source: finalizeRemoveNode then dockPanel(zone, {type:split,edge})', async () => {
    const srcCanvas = createMockCanvasStore()
    findCanvasStoreForNodeMock.mockReturnValue(srcCanvas.store)
    const tgtDock = createMockDockStore()
    findZoneForStackMock.mockReturnValue('bottom')
    const source: DragSource = {
      panelId: 'panel-1',
      origin: { kind: 'canvas-node', canvasStoreApi: srcCanvas.store, nodeId: 'node-S' },
    }
    const target: DropTarget = {
      kind: 'dock-split',
      dockStoreApi: tgtDock.store,
      stackId: 'stack-T',
      edge: 'right',
    }
    await commitDrop(source, target, panel, defaultCtx())
    expect(srcCanvas.state.finalizeRemoveNode).toHaveBeenCalledWith('node-S')
    expect(tgtDock.state.dockPanel).toHaveBeenCalledWith('panel-1', 'bottom', {
      type: 'split',
      stackId: 'stack-T',
      edge: 'right',
    })
  })
})

// -----------------------------------------------------------------------------
// detach
// -----------------------------------------------------------------------------

describe('commitDrop — detach', () => {
  it('claimed cross-window drop removes source and does NOT call dragDetach', async () => {
    const srcCanvas = createMockCanvasStore()
    findCanvasStoreForNodeMock.mockReturnValue(srcCanvas.store)
    const source: DragSource = {
      panelId: 'panel-1',
      origin: { kind: 'canvas-node', canvasStoreApi: srcCanvas.store, nodeId: 'node-S' },
    }
    const target: DropTarget = { kind: 'detach', screen: { x: 999, y: 100 } }
    const ctx = defaultCtx({
      crossWindowResolve: vi.fn(async () => ({ claimed: true })),
      dragDetach: vi.fn(async () => 1),
    })
    await commitDrop(source, target, panel, ctx)
    expect(ctx.crossWindowResolve).toHaveBeenCalled()
    expect(ctx.dragDetach).not.toHaveBeenCalled()
    expect(srcCanvas.state.finalizeRemoveNode).toHaveBeenCalledWith('node-S')
    expect(ctx.onRemovedFromCanvas).toHaveBeenCalledWith('panel-1', 'editor')
  })

  it('unclaimed: falls back to dragDetach and removes source on success', async () => {
    const srcCanvas = createMockCanvasStore()
    findCanvasStoreForNodeMock.mockReturnValue(srcCanvas.store)
    const source: DragSource = {
      panelId: 'panel-1',
      origin: { kind: 'canvas-node', canvasStoreApi: srcCanvas.store, nodeId: 'node-S' },
    }
    const target: DropTarget = { kind: 'detach', screen: { x: 999, y: 100 } }
    const ctx = defaultCtx({
      crossWindowResolve: vi.fn(async () => ({ claimed: false })),
      dragDetach: vi.fn(async () => 42),
    })
    await commitDrop(source, target, panel, ctx)
    expect(ctx.dragDetach).toHaveBeenCalled()
    expect(srcCanvas.state.finalizeRemoveNode).toHaveBeenCalledWith('node-S')
  })

  it('unclaimed: detach refused (winId null) leaves source intact', async () => {
    const srcCanvas = createMockCanvasStore()
    findCanvasStoreForNodeMock.mockReturnValue(srcCanvas.store)
    const source: DragSource = {
      panelId: 'panel-1',
      origin: { kind: 'canvas-node', canvasStoreApi: srcCanvas.store, nodeId: 'node-S' },
    }
    const target: DropTarget = { kind: 'detach', screen: { x: 999, y: 100 } }
    const ctx = defaultCtx({
      crossWindowResolve: vi.fn(async () => ({ claimed: false })),
      dragDetach: vi.fn(async () => null),
    })
    await commitDrop(source, target, panel, ctx)
    expect(ctx.dragDetach).toHaveBeenCalled()
    expect(srcCanvas.state.finalizeRemoveNode).not.toHaveBeenCalled()
    expect(ctx.onRemovedFromCanvas).not.toHaveBeenCalled()
  })

  it('unclaimed: when buildSnapshot returns null, calls crossWindowCancel and exits', async () => {
    const srcCanvas = createMockCanvasStore()
    findCanvasStoreForNodeMock.mockReturnValue(srcCanvas.store)
    const source: DragSource = {
      panelId: 'panel-1',
      origin: { kind: 'canvas-node', canvasStoreApi: srcCanvas.store, nodeId: 'node-S' },
    }
    const target: DropTarget = { kind: 'detach', screen: { x: 999, y: 100 } }
    const ctx = defaultCtx({
      crossWindowResolve: vi.fn(async () => ({ claimed: false })),
      buildSnapshot: vi.fn(() => null),
    })
    await commitDrop(source, target, panel, ctx)
    expect(ctx.crossWindowCancel).toHaveBeenCalled()
    expect(ctx.dragDetach).not.toHaveBeenCalled()
    expect(srcCanvas.state.finalizeRemoveNode).not.toHaveBeenCalled()
  })
})

describe('commitDrop — onRemovedFromCanvas notification', () => {
  it('does not fire on canvas-add removal (same-window move preserves panel resources)', async () => {
    const dock = createMockDockStore()
    const tgt = createMockCanvasStore()
    const source: DragSource = {
      panelId: 'p-term',
      origin: { kind: 'dock-tab', dockStoreApi: dock.store, zone: 'left' as never, stackId: 'stack-1' },
    }
    const target: DropTarget = {
      kind: 'canvas-add',
      canvasStoreApi: tgt.store,
      origin: { x: 0, y: 0 },
      size: { width: 200, height: 150 },
    }
    const ctx = defaultCtx()
    await commitDrop(
      source,
      target,
      { id: 'p-term', type: 'terminal', title: 'T' },
      ctx,
    )
    expect(ctx.onRemovedFromCanvas).not.toHaveBeenCalled()
  })
})

// -----------------------------------------------------------------------------
// Regression: PTY release between unmount/remount in same-window moves kills the
// terminal — issue: terminal goes gray after local drag.
// -----------------------------------------------------------------------------

describe('commitDrop — terminal PTY preservation on same-window drags', () => {
  it('local canvas-add from dock-tab does NOT call onRemovedFromCanvas for terminal sources', async () => {
    const dock = createMockDockStore()
    const tgt = createMockCanvasStore()
    const source: DragSource = {
      panelId: 'p-term',
      origin: { kind: 'dock-tab', dockStoreApi: dock.store, zone: 'left' as never, stackId: 'stack-1' },
    }
    const target: DropTarget = {
      kind: 'canvas-add',
      canvasStoreApi: tgt.store,
      origin: { x: 0, y: 0 },
      size: { width: 200, height: 150 },
    }
    const ctx = defaultCtx()
    await commitDrop(
      source,
      target,
      { id: 'p-term', type: 'terminal', title: 'T' },
      ctx,
    )
    expect(ctx.onRemovedFromCanvas).not.toHaveBeenCalled()
  })

  it('local dock-zone from canvas-node does NOT call onRemovedFromCanvas for terminal sources', async () => {
    const srcCanvas = createMockCanvasStore()
    findCanvasStoreForNodeMock.mockReturnValue(srcCanvas.store)
    const tgtDock = createMockDockStore()
    const source: DragSource = {
      panelId: 'p-term',
      origin: { kind: 'canvas-node', canvasStoreApi: srcCanvas.store, nodeId: 'node-S' },
    }
    const target: DropTarget = {
      kind: 'dock-zone',
      dockStoreApi: tgtDock.store,
      zone: 'left' as never,
    }
    const ctx = defaultCtx()
    await commitDrop(
      source,
      target,
      { id: 'p-term', type: 'terminal', title: 'T' },
      ctx,
    )
    expect(ctx.onRemovedFromCanvas).not.toHaveBeenCalled()
  })

  it('detach target DOES call onRemovedFromCanvas for terminal (cross-window: new PTY at destination)', async () => {
    const srcCanvas = createMockCanvasStore()
    findCanvasStoreForNodeMock.mockReturnValue(srcCanvas.store)
    const source: DragSource = {
      panelId: 'p-term',
      origin: { kind: 'canvas-node', canvasStoreApi: srcCanvas.store, nodeId: 'node-S' },
    }
    const target: DropTarget = { kind: 'detach', screen: { x: 999, y: 100 } }
    const ctx = defaultCtx({
      crossWindowResolve: vi.fn(async () => ({ claimed: true })),
    })
    await commitDrop(
      source,
      target,
      { id: 'p-term', type: 'terminal', title: 'T' },
      ctx,
    )
    expect(ctx.onRemovedFromCanvas).toHaveBeenCalledWith('p-term', 'terminal')
  })
})
