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
  }
}

function createMockCanvasStore(): MockCanvas {
  const state = makeMockCanvasState()
  // Re-bind moveNode to mutate local node entries.
  state.moveNode = vi.fn((id: string, origin: { x: number; y: number }) => {
    if (state.nodes[id]) state.nodes[id].origin = origin
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
  it('calls moveNode(nodeId, origin)', async () => {
    const c = createMockCanvasStore()
    c.state.nodes['node-1'] = {
      id: 'node-1',
      origin: { x: 0, y: 0 },
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
      origin: { x: 100, y: 100 },
    }
    await commitDrop(source, target, panel, defaultCtx())
    expect(c.state.moveNode).toHaveBeenCalledWith('node-1', { x: 100, y: 100 })
  })

  it('group move: translates every member by the (snapped) anchor delta', async () => {
    const c = createMockCanvasStore()
    c.state.nodes['anchor'] = { id: 'anchor', origin: { x: 100, y: 100 }, size: { width: 100, height: 100 } }
    c.state.nodes['m1'] = { id: 'm1', origin: { x: 400, y: 100 }, size: { width: 100, height: 100 } }
    c.state.nodes['m2'] = { id: 'm2', origin: { x: 100, y: 400 }, size: { width: 100, height: 100 } }
    const source: DragSource = {
      panelId: 'panel-1',
      origin: {
        kind: 'canvas-node',
        canvasStoreApi: c.store,
        nodeId: 'anchor',
        startOrigin: { x: 100, y: 100 },
        members: [
          { nodeId: 'm1', startOrigin: { x: 400, y: 100 } },
          { nodeId: 'm2', startOrigin: { x: 100, y: 400 } },
        ],
      },
    }
    // Anchor lands at the snapped (120, 140) → delta (+20, +40).
    const target: DropTarget = {
      kind: 'canvas-reposition',
      canvasStoreApi: c.store,
      nodeId: 'anchor',
      origin: { x: 120, y: 140 },
    }
    await commitDrop(source, target, panel, defaultCtx())
    expect(c.state.moveNode).toHaveBeenCalledWith('anchor', { x: 120, y: 140 })
    expect(c.state.moveNode).toHaveBeenCalledWith('m1', { x: 420, y: 140 })
    expect(c.state.moveNode).toHaveBeenCalledWith('m2', { x: 120, y: 440 })
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

// -----------------------------------------------------------------------------
// Edge cases: stale state mid-drag — sources/targets that vanished or broke
// between resolve and commit must never lose the panel or leak a pending-detach.
// -----------------------------------------------------------------------------

describe('commitDrop — canvas-on-canvas refusal', () => {
  it('refuses the drop without touching the source (would silently delete a canvas tab)', async () => {
    const dock = createMockDockStore()
    const tgt = createMockCanvasStore()
    const source: DragSource = {
      panelId: 'cv-1',
      origin: { kind: 'dock-tab', dockStoreApi: dock.store, zone: 'center' as never, stackId: 'stack-1' },
    }
    const target: DropTarget = {
      kind: 'canvas-add',
      canvasStoreApi: tgt.store,
      origin: { x: 0, y: 0 },
      size: { width: 400, height: 300 },
    }
    await commitDrop(source, target, { id: 'cv-1', type: 'canvas', title: 'Board' }, defaultCtx())
    expect(dock.state.undockPanel).not.toHaveBeenCalled()
    expect(tgt.state.addNode).not.toHaveBeenCalled()
  })
})

describe('commitDrop — panel-window source onto dock targets', () => {
  it('dock-tab and dock-split targets are no-ops (own-window dock is impossible)', async () => {
    const tgtDock = createMockDockStore()
    const source: DragSource = { panelId: 'panel-1', origin: { kind: 'panel-window' } }

    await commitDrop(
      source,
      { kind: 'dock-tab', dockStoreApi: tgtDock.store, stackId: 'stack-T' },
      panel,
      defaultCtx(),
    )
    await commitDrop(
      source,
      { kind: 'dock-split', dockStoreApi: tgtDock.store, stackId: 'stack-T', edge: 'right' },
      panel,
      defaultCtx(),
    )

    expect(tgtDock.state.dockPanel).not.toHaveBeenCalled()
  })
})

describe('commitDrop — source vanished mid-drag', () => {
  it('source dock unmounted (undockPanel throws): swallowed, panel still docks into the target', async () => {
    const srcDock = createMockDockStore()
    srcDock.state.undockPanel = vi.fn(() => {
      throw new Error('source dock unmounted')
    })
    const tgtDock = createMockDockStore()
    const source: DragSource = {
      panelId: 'panel-1',
      origin: { kind: 'dock-tab', dockStoreApi: srcDock.store, zone: 'left' as never, stackId: 'stack-S' },
    }
    const target: DropTarget = {
      kind: 'dock-zone',
      dockStoreApi: tgtDock.store,
      zone: 'bottom' as never,
    }

    await commitDrop(source, target, panel, defaultCtx())

    expect(tgtDock.state.dockPanel).toHaveBeenCalledWith('panel-1', 'bottom')
  })

  it('source canvas store released (reconcile yields null): no crash, target placement still lands', async () => {
    findCanvasStoreForNodeMock.mockReturnValue(null)
    const tgtCanvas = createMockCanvasStore()
    const source: DragSource = {
      panelId: 'panel-1',
      // The store was released mid-drag; the session has no store for the node
      // and the caller-provided handle is gone too.
      origin: { kind: 'canvas-node', canvasStoreApi: null as never, nodeId: 'node-gone' },
    }
    const target: DropTarget = {
      kind: 'canvas-add',
      canvasStoreApi: tgtCanvas.store,
      origin: { x: 0, y: 0 },
      size: { width: 320, height: 200 },
    }

    await commitDrop(source, target, panel, defaultCtx())

    expect(tgtCanvas.state.addNode).toHaveBeenCalledWith(
      'panel-1',
      'editor',
      { x: 0, y: 0 },
      { width: 320, height: 200 },
    )
  })
})

describe('commitDrop — pending-detach pairing under IPC failure', () => {
  function detachSetup() {
    const srcCanvas = createMockCanvasStore()
    findCanvasStoreForNodeMock.mockReturnValue(srcCanvas.store)
    const source: DragSource = {
      panelId: 'panel-1',
      origin: { kind: 'canvas-node', canvasStoreApi: srcCanvas.store, nodeId: 'node-S' },
    }
    const target: DropTarget = { kind: 'detach', screen: { x: 999, y: 100 } }
    const beginPendingDetach = vi.fn()
    const endPendingDetach = vi.fn()
    return { srcCanvas, source, target, beginPendingDetach, endPendingDetach }
  }

  it('crossWindowResolve rejects: endPendingDetach still runs, source untouched', async () => {
    const { srcCanvas, source, target, beginPendingDetach, endPendingDetach } = detachSetup()
    const ctx = defaultCtx({
      crossWindowResolve: vi.fn(async () => {
        throw new Error('ipc dead')
      }),
      beginPendingDetach,
      endPendingDetach,
    })

    await expect(commitDrop(source, target, panel, ctx)).rejects.toThrow('ipc dead')

    expect(beginPendingDetach).toHaveBeenCalledWith('panel-1', 'node-S')
    expect(endPendingDetach).toHaveBeenCalledWith('panel-1')
    expect(srcCanvas.state.finalizeRemoveNode).not.toHaveBeenCalled()
  })

  it('dragDetach rejects: endPendingDetach still runs, source untouched', async () => {
    const { srcCanvas, source, target, beginPendingDetach, endPendingDetach } = detachSetup()
    const ctx = defaultCtx({
      crossWindowResolve: vi.fn(async () => ({ claimed: false })),
      dragDetach: vi.fn(async () => {
        throw new Error('window spawn failed')
      }),
      beginPendingDetach,
      endPendingDetach,
    })

    await expect(commitDrop(source, target, panel, ctx)).rejects.toThrow('window spawn failed')

    expect(endPendingDetach).toHaveBeenCalledWith('panel-1')
    expect(srcCanvas.state.finalizeRemoveNode).not.toHaveBeenCalled()
  })

  it('dock-tab source passes a null nodeId to beginPendingDetach', async () => {
    const srcDock = createMockDockStore()
    const source: DragSource = {
      panelId: 'panel-1',
      origin: { kind: 'dock-tab', dockStoreApi: srcDock.store, zone: 'left' as never, stackId: 'stack-S' },
    }
    const target: DropTarget = { kind: 'detach', screen: { x: 999, y: 100 } }
    const beginPendingDetach = vi.fn()
    const endPendingDetach = vi.fn()
    const ctx = defaultCtx({
      crossWindowResolve: vi.fn(async () => ({ claimed: true })),
      beginPendingDetach,
      endPendingDetach,
    })

    await commitDrop(source, target, panel, ctx)

    expect(beginPendingDetach).toHaveBeenCalledWith('panel-1', null)
    expect(endPendingDetach).toHaveBeenCalledWith('panel-1')
    expect(srcDock.state.undockPanel).toHaveBeenCalledWith('panel-1')
  })
})
