// @vitest-environment jsdom
// =============================================================================
// Tests for the live-store snapshot resolvers (Fix 3):
// getWorkspaceCanvasSnapshot / getWorkspaceDockSnapshot.
//
// The live per-canvas CanvasStore and per-workspace DockStore are the single
// in-memory source of truth; the WorkspaceState.canvasNodes/dockState fields are
// persistence-only projections read ONLY through these resolvers. The key
// regression guard: a never-mounted workspace must fall back to its saved
// projection and must NOT create an empty live store (which would serialize `{}`
// over saved children).
//
// Clean exit: no watchers/timers are armed here; teardown unregisters canvas
// ops, releases the dock store, clears the primary-canvas cache, and resets
// appStore.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getWorkspaceCanvasSnapshot,
  getCanvasSnapshotForPanel,
  getWorkspaceCanvasPanelIds,
  getWorkspaceDockSnapshot,
  registerCanvasOps,
  unregisterCanvasOps,
  invalidateWorkspaceCanvasCache,
  getCanvasOpsById,
} from './canvasAccess'
import {
  getOrCreateWorkspaceDockStore,
  releaseWorkspaceDockStore,
} from './dockRegistry'
import { useAppStore } from '../../stores/appStore'

const WS = 'ws-snap'
const CANVAS = 'canvas-panel-1'
const CANVAS2 = 'canvas-panel-2'

function setWorkspace(extra: Record<string, unknown>, panels?: Record<string, unknown>) {
  useAppStore.setState({
    workspaces: [
      {
        id: WS,
        rootPath: '/repo',
        panels: panels ?? { [CANVAS]: { id: CANVAS, type: 'canvas', title: 'Canvas' } },
        ...extra,
      } as any,
    ],
  } as any)
}

function fakeCanvasOps(nodes: Record<string, unknown>) {
  return {
    storeApi: {
      getState: () => ({
        nodes,
        zoomLevel: 2,
        viewportOffset: { x: 5, y: 6 },
        nodeForPanel: (panelId: string) =>
          Object.values(nodes).some((n: any) => n.panelId === panelId) ? 'node-x' : undefined,
      }),
    },
  } as any
}

beforeEach(() => {
  ;(window as any).electronAPI = {}
})

afterEach(() => {
  unregisterCanvasOps(CANVAS)
  unregisterCanvasOps(CANVAS2)
  invalidateWorkspaceCanvasCache(WS)
  releaseWorkspaceDockStore(WS)
  useAppStore.setState({ workspaces: [] } as any)
  vi.restoreAllMocks()
})

describe('getWorkspaceCanvasSnapshot', () => {
  it('reads the LIVE canvas store when one is registered', () => {
    setWorkspace({
      // A stale persisted projection that must be ignored in favor of live.
      canvasNodes: { old: { id: 'old', panelId: 'p-old' } },
      zoomLevel: 1,
      viewportOffset: { x: 0, y: 0 },
    })
    registerCanvasOps(CANVAS, fakeCanvasOps({ n1: { id: 'n1', panelId: 'p1' } }))

    const snap = getWorkspaceCanvasSnapshot(WS)
    expect(snap).not.toBeNull()
    expect(Object.keys(snap!.nodes)).toEqual(['n1'])
    expect(snap!.zoomLevel).toBe(2)
    expect(snap!.viewportOffset).toEqual({ x: 5, y: 6 })
  })

  it('falls back to the persisted projection for a never-mounted workspace (no empty overwrite)', () => {
    setWorkspace({
      canvases: {
        [CANVAS]: {
          id: CANVAS,
          canvasNodes: { saved: { id: 'saved', panelId: 'p-saved' } },
          zoomLevel: 1.5,
          viewportOffset: { x: 10, y: 20 },
        },
      },
    })
    // No ops registered for CANVAS.
    const snap = getWorkspaceCanvasSnapshot(WS)
    expect(Object.keys(snap!.nodes)).toEqual(['saved'])
    expect(snap!.zoomLevel).toBe(1.5)
    expect(snap!.viewportOffset).toEqual({ x: 10, y: 20 })
    // Critical: the resolver must NOT have created a live store for the canvas.
    expect(getCanvasOpsById(CANVAS)).toBeNull()
  })

  it('returns null for an unknown workspace', () => {
    expect(getWorkspaceCanvasSnapshot('nope')).toBeNull()
  })
})

describe('getCanvasSnapshotForPanel (multi-canvas)', () => {
  const twoCanvasPanels = {
    [CANVAS]: { id: CANVAS, type: 'canvas', title: 'Primary' },
    [CANVAS2]: { id: CANVAS2, type: 'canvas', title: 'Secondary' },
  }

  it('reads the LIVE store for a specific canvas panel when mounted', () => {
    setWorkspace({ canvasNodes: {}, zoomLevel: 1, viewportOffset: { x: 0, y: 0 } }, twoCanvasPanels)
    registerCanvasOps(CANVAS2, fakeCanvasOps({ s1: { id: 's1', panelId: 'p-sec' } }))

    const snap = getCanvasSnapshotForPanel(CANVAS2)
    expect(Object.keys(snap!.nodes)).toEqual(['s1'])
    expect(snap!.zoomLevel).toBe(2)
    expect(snap!.viewportOffset).toEqual({ x: 5, y: 6 })
  })

  it('falls back to the persisted ws.canvases entry when not mounted', () => {
    setWorkspace(
      {
        canvasNodes: { prim: { id: 'prim', panelId: 'p-prim' } },
        zoomLevel: 1,
        viewportOffset: { x: 0, y: 0 },
        canvases: {
          [CANVAS2]: {
            id: CANVAS2,
            canvasNodes: { sec: { id: 'sec', panelId: 'p-sec' } },
            zoomLevel: 3,
            viewportOffset: { x: 7, y: 8 },
          },
        },
      },
      twoCanvasPanels,
    )

    const snap = getCanvasSnapshotForPanel(CANVAS2)
    expect(Object.keys(snap!.nodes)).toEqual(['sec'])
    expect(snap!.zoomLevel).toBe(3)
    expect(snap!.viewportOffset).toEqual({ x: 7, y: 8 })
    // Critical: a never-mounted secondary canvas must NOT get a live store.
    expect(getCanvasOpsById(CANVAS2)).toBeNull()
  })

  it('a never-mounted canvas with no canvases entry resolves to empty (primary and secondary alike)', () => {
    setWorkspace({}, twoCanvasPanels)
    // No canvases map and neither mounted ⇒ empty nodes for BOTH. The primary is
    // no longer special-cased with a legacy top-level projection.
    expect(getCanvasSnapshotForPanel(CANVAS)!.nodes).toEqual({})
    expect(getCanvasSnapshotForPanel(CANVAS2)!.nodes).toEqual({})
  })

  it('lists every canvas panel id in the workspace', () => {
    setWorkspace({}, twoCanvasPanels)
    expect(getWorkspaceCanvasPanelIds(WS).sort()).toEqual([CANVAS, CANVAS2].sort())
  })
})

describe('getWorkspaceDockSnapshot', () => {
  it('returns the persisted dockState when no live dock store exists', () => {
    const dockState = { zones: { center: { visible: true, layout: null } }, locations: {} }
    setWorkspace({ dockState })
    expect(getWorkspaceDockSnapshot(WS)).toBe(dockState)
  })

  it('reads the LIVE dock store snapshot once one is created', () => {
    setWorkspace({ dockState: undefined })
    const dock = getOrCreateWorkspaceDockStore(WS)
    dock.getState().dockPanel('p-term', 'left')

    const snap = getWorkspaceDockSnapshot(WS)
    expect(snap).toBeDefined()
    expect(snap!.locations['p-term']).toBeDefined()
    expect(snap!.locations['p-term'].type).toBe('dock')
  })
})
