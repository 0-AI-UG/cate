import { describe, it, expect, vi } from 'vitest'

// Stub heavy default-env imports — the tests pass their own DropEnvironment so
// these are never invoked, but importing resolve.ts pulls them transitively
// (CanvasPanel → React/Monaco/electron-log). Mocking keeps the suite pure.
vi.mock('../stores/canvasStore', () => ({
  getOrCreateCanvasStoreForPanel: () => null,
  findCanvasStoreForNode: () => null,
}))
vi.mock('../panels/CanvasPanel', () => ({
  findNodeIdForDockStore: () => null,
}))

import type { StoreApi } from 'zustand'
import { resolveDrop, type DropEnvironment } from './resolve'
import type { DragSource } from './types'
import type { CanvasStore } from '../stores/canvasStore'
import type { DockStore } from '../stores/dockStore'
import type { DropZoneEntry } from './registry'
import type { PanelType, Point, WindowDockState, DockTabStack } from '../../shared/types'

function makeDockStoreWithStack(
  stackId: string,
  panelIds: string[],
  zone: 'left' | 'right' | 'bottom' | 'center' = 'left',
): StoreApi<DockStore> {
  const stack: DockTabStack = { type: 'tabs', id: stackId, panelIds, activeIndex: 0 }
  const empty = { position: 'left' as const, visible: true, size: 200, layout: null }
  const zones: WindowDockState = {
    left: { ...empty, position: 'left' },
    right: { ...empty, position: 'right' },
    bottom: { ...empty, position: 'bottom' },
    center: { ...empty, position: 'center' },
  }
  zones[zone] = { ...zones[zone], layout: stack }
  const state = { zones }
  return {
    getState() {
      return state as unknown as DockStore
    },
    setState() {},
    subscribe() {
      return () => {}
    },
    destroy() {},
  } as unknown as StoreApi<DockStore>
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON() {
      return {}
    },
  } as DOMRect
}

// Helper: build a fake canvas store with a controllable zoom & viewport.
function fakeCanvasStore(
  zoom: number = 1,
  viewport: Point = { x: 0, y: 0 },
): StoreApi<CanvasStore> {
  const state = { zoomLevel: zoom, viewportOffset: viewport }
  return {
    getState() {
      return state as unknown as CanvasStore
    },
    setState() {},
    subscribe() {
      return () => {}
    },
    destroy() {},
  } as unknown as StoreApi<CanvasStore>
}

function fakeDockStore(): StoreApi<DockStore> {
  return {} as unknown as StoreApi<DockStore>
}

interface EnvOptions {
  zones?: DropZoneEntry[]
  canvasAt?: DropEnvironment['canvasAtCursor']
  findOwner?: DropEnvironment['findOwningCanvasForDockStore']
}

function env(opts: EnvOptions = {}): DropEnvironment {
  return {
    canvasAtCursor: opts.canvasAt ?? (() => null),
    dropZones: opts.zones ?? [],
    findOwningCanvasForDockStore:
      opts.findOwner ?? (() => null),
  }
}

const CANVAS_STORE_A = fakeCanvasStore(1, { x: 0, y: 0 })
const CANVAS_STORE_B = fakeCanvasStore(1, { x: 0, y: 0 })
const DOCK_STORE = fakeDockStore()

const NODE_SOURCE_A: DragSource = {
  panelId: 'panel-A',
  origin: {
    kind: 'canvas-node',
    canvasStoreApi: CANVAS_STORE_A,
    nodeId: 'node-A',
  },
}
const TAB_SOURCE: DragSource = {
  panelId: 'panel-T',
  origin: {
    kind: 'dock-tab',
    dockStoreApi: DOCK_STORE,
    zone: 'left' as never,
    stackId: 'stack-1',
  },
}

const ghostSize = { width: 320, height: 200 }
const grab = { x: 10, y: 5 }

// -----------------------------------------------------------------------------
// Outside-window
// -----------------------------------------------------------------------------

describe('resolveDrop — outside window', () => {
  it('returns detach with cursor.screen when insideWindow=false', () => {
    const target = resolveDrop(
      { client: { x: -10, y: 100 }, screen: { x: 999, y: 100 }, insideWindow: false },
      NODE_SOURCE_A,
      grab,
      ghostSize,
      'editor',
      env(),
    )
    expect(target).toEqual({ kind: 'detach', screen: { x: 999, y: 100 } })
  })
})

// -----------------------------------------------------------------------------
// Dock zones
// -----------------------------------------------------------------------------

describe('resolveDrop — dock zones', () => {
  const stackEntry: DropZoneEntry = {
    id: 'stack-1',
    zone: 'center',
    stackId: 'stack-1',
    dockStoreApi: DOCK_STORE,
    getRect: () => rect(0, 0, 500, 400),
  }

  function dropAt(client: Point, source: DragSource = NODE_SOURCE_A, type: PanelType = 'editor') {
    return resolveDrop(
      { client, screen: client, insideWindow: true },
      source,
      grab,
      ghostSize,
      type,
      env({ zones: [stackEntry] }),
    )
  }

  it('top 38px → dock-tab', () => {
    const t = dropAt({ x: 250, y: 10 })
    expect(t).toEqual({ kind: 'dock-tab', dockStoreApi: DOCK_STORE, stackId: 'stack-1' })
  })

  it('top edge band (below tab-bar) → dock-split top', () => {
    const t = dropAt({ x: 250, y: 40 })
    expect(t).toEqual({
      kind: 'dock-split',
      dockStoreApi: DOCK_STORE,
      stackId: 'stack-1',
      edge: 'top',
    })
  })

  it('left edge → dock-split left', () => {
    const t = dropAt({ x: 10, y: 200 })
    expect(t).toEqual({
      kind: 'dock-split',
      dockStoreApi: DOCK_STORE,
      stackId: 'stack-1',
      edge: 'left',
    })
  })

  it('body center → null (falls through)', () => {
    const t = dropAt({ x: 250, y: 200 })
    expect(t).toBeNull()
  })

  it('smallest area wins when multiple stacks overlap', () => {
    const big: DropZoneEntry = {
      id: 'big',
      zone: 'center',
      stackId: 'big-stack',
      dockStoreApi: DOCK_STORE,
      getRect: () => rect(0, 0, 1000, 800),
    }
    const small: DropZoneEntry = {
      id: 'small',
      zone: 'center',
      stackId: 'small-stack',
      dockStoreApi: DOCK_STORE,
      getRect: () => rect(0, 0, 300, 200),
    }
    const t = resolveDrop(
      { client: { x: 150, y: 10 }, screen: { x: 150, y: 10 }, insideWindow: true },
      NODE_SOURCE_A,
      grab,
      ghostSize,
      'editor',
      env({ zones: [big, small] }),
    )
    expect((t as { stackId?: string })?.stackId).toBe('small-stack')
  })

  it('self-drop guard: single-tab dock-tab (center) on its own stack returns null', () => {
    const dock = makeDockStoreWithStack('stack-1', ['only'])
    const ownStack: DropZoneEntry = {
      id: 'own',
      zone: 'left',
      stackId: 'stack-1',
      dockStoreApi: dock,
      getRect: () => rect(0, 0, 500, 400),
    }
    const src: DragSource = {
      panelId: 'panel-T',
      origin: { kind: 'dock-tab', dockStoreApi: dock, zone: 'left', stackId: 'stack-1' },
    }
    const t = resolveDrop(
      { client: { x: 250, y: 10 }, screen: { x: 250, y: 10 }, insideWindow: true },
      src,
      grab,
      ghostSize,
      'editor',
      env({ zones: [ownStack] }),
    )
    expect(t).toBeNull()
  })

  it('multi-tab center-to-self: dock-tab on own stack center with >1 panel → dock-tab', () => {
    const dock = makeDockStoreWithStack('stack-1', ['a', 'b', 'c'])
    const ownStack: DropZoneEntry = {
      id: 'own',
      zone: 'left',
      stackId: 'stack-1',
      dockStoreApi: dock,
      getRect: () => rect(0, 0, 500, 400),
    }
    const src: DragSource = {
      panelId: 'panel-T',
      origin: { kind: 'dock-tab', dockStoreApi: dock, zone: 'left', stackId: 'stack-1' },
    }
    const t = resolveDrop(
      { client: { x: 250, y: 10 }, screen: { x: 250, y: 10 }, insideWindow: true },
      src,
      grab,
      ghostSize,
      'editor',
      env({ zones: [ownStack] }),
    )
    expect(t).toEqual({ kind: 'dock-tab', dockStoreApi: dock, stackId: 'stack-1' })
  })

  it('multi-tab split-to-self: dock-tab on own stack right edge with >1 panel → dock-split right', () => {
    const dock = makeDockStoreWithStack('stack-1', ['a', 'b', 'c'])
    const ownStack: DropZoneEntry = {
      id: 'own',
      zone: 'left',
      stackId: 'stack-1',
      dockStoreApi: dock,
      getRect: () => rect(0, 0, 500, 400),
    }
    const src: DragSource = {
      panelId: 'panel-T',
      origin: { kind: 'dock-tab', dockStoreApi: dock, zone: 'left', stackId: 'stack-1' },
    }
    // Right edge band — well inside the right edge of the 500x400 rect.
    const t = resolveDrop(
      { client: { x: 490, y: 200 }, screen: { x: 490, y: 200 }, insideWindow: true },
      src,
      grab,
      ghostSize,
      'editor',
      env({ zones: [ownStack] }),
    )
    expect(t).toEqual({
      kind: 'dock-split',
      dockStoreApi: dock,
      stackId: 'stack-1',
      edge: 'right',
    })
  })

  it('single-tab split-to-self: edge target on own stack with 1 panel → null (no-op)', () => {
    const dock = makeDockStoreWithStack('stack-1', ['only'])
    const ownStack: DropZoneEntry = {
      id: 'own',
      zone: 'left',
      stackId: 'stack-1',
      dockStoreApi: dock,
      getRect: () => rect(0, 0, 500, 400),
    }
    const src: DragSource = {
      panelId: 'panel-T',
      origin: { kind: 'dock-tab', dockStoreApi: dock, zone: 'left', stackId: 'stack-1' },
    }
    const t = resolveDrop(
      { client: { x: 490, y: 200 }, screen: { x: 490, y: 200 }, insideWindow: true },
      src,
      grab,
      ghostSize,
      'editor',
      env({ zones: [ownStack] }),
    )
    expect(t).toBeNull()
  })

  it('cross-stack split: dock-tab on a DIFFERENT stack edge → valid dock-split', () => {
    const dock = makeDockStoreWithStack('stack-1', ['a', 'b'])
    const otherStack: DropZoneEntry = {
      id: 'other',
      zone: 'left',
      stackId: 'stack-2',
      dockStoreApi: dock,
      getRect: () => rect(0, 0, 500, 400),
    }
    const src: DragSource = {
      panelId: 'panel-T',
      origin: { kind: 'dock-tab', dockStoreApi: dock, zone: 'left', stackId: 'stack-1' },
    }
    const t = resolveDrop(
      { client: { x: 490, y: 200 }, screen: { x: 490, y: 200 }, insideWindow: true },
      src,
      grab,
      ghostSize,
      'editor',
      env({ zones: [otherStack] }),
    )
    expect(t).toEqual({
      kind: 'dock-split',
      dockStoreApi: dock,
      stackId: 'stack-2',
      edge: 'right',
    })
  })

  it('respects acceptsPanelType filter on the entry (canvas-into-canvas rejection)', () => {
    const noCanvas: DropZoneEntry = {
      id: 'mini',
      zone: 'center',
      stackId: 'mini-stack',
      dockStoreApi: DOCK_STORE,
      acceptsPanelType: (t) => t !== 'canvas',
      getRect: () => rect(0, 0, 500, 400),
    }
    const t = resolveDrop(
      { client: { x: 250, y: 10 }, screen: { x: 250, y: 10 }, insideWindow: true },
      NODE_SOURCE_A,
      grab,
      ghostSize,
      'canvas',
      env({ zones: [noCanvas] }),
    )
    expect(t).toBeNull()
  })
})

// -----------------------------------------------------------------------------
// Canvas surface
// -----------------------------------------------------------------------------

describe('resolveDrop — canvas surface', () => {
  it('canvas-node on same canvas → canvas-reposition with origin', () => {
    const cursor = { x: 300, y: 200 }
    const t = resolveDrop(
      { client: cursor, screen: cursor, insideWindow: true },
      NODE_SOURCE_A,
      { x: 50, y: 25 },
      ghostSize,
      'editor',
      env({
        canvasAt: () => ({
          panelId: 'canvas-A',
          rect: rect(0, 0, 1000, 800),
          canvasStoreApi: CANVAS_STORE_A,
        }),
      }),
    )
    expect(t).toEqual({
      kind: 'canvas-reposition',
      canvasStoreApi: CANVAS_STORE_A,
      nodeId: 'node-A',
      origin: { x: 250, y: 175 },
    })
  })

  it('canvas-node from a different canvas → canvas-add', () => {
    const cursor = { x: 100, y: 100 }
    const t = resolveDrop(
      { client: cursor, screen: cursor, insideWindow: true },
      NODE_SOURCE_A,
      { x: 0, y: 0 },
      ghostSize,
      'editor',
      env({
        canvasAt: () => ({
          panelId: 'canvas-B',
          rect: rect(0, 0, 1000, 800),
          canvasStoreApi: CANVAS_STORE_B,
        }),
      }),
    )
    expect(t).toEqual({
      kind: 'canvas-add',
      canvasStoreApi: CANVAS_STORE_B,
      origin: { x: 100, y: 100 },
      size: ghostSize,
    })
  })

  it('dock-tab from main dock → canvas-add', () => {
    const cursor = { x: 100, y: 100 }
    const t = resolveDrop(
      { client: cursor, screen: cursor, insideWindow: true },
      TAB_SOURCE,
      { x: 0, y: 0 },
      ghostSize,
      'editor',
      env({
        canvasAt: () => ({
          panelId: 'canvas-A',
          rect: rect(0, 0, 1000, 800),
          canvasStoreApi: CANVAS_STORE_A,
        }),
        // No owning canvas — this tab is a global-dock tab.
        findOwner: () => null,
      }),
    )
    expect(t).toMatchObject({ kind: 'canvas-add', canvasStoreApi: CANVAS_STORE_A })
  })

  it('dock-tab from a mini-dock dropped back onto its own canvas → canvas-add (detach into new node)', () => {
    // Single-tab tab drags are dispatched as canvas-node specs by the host,
    // so any dock-tab spec hitting this path is by definition a multi-tab
    // detach — it should create a new node on the canvas, not move the source.
    const cursor = { x: 300, y: 200 }
    const t = resolveDrop(
      { client: cursor, screen: cursor, insideWindow: true },
      { ...TAB_SOURCE, origin: { ...TAB_SOURCE.origin, sourceNodeId: 'node-A' } as DragSource['origin'] },
      { x: 0, y: 0 },
      ghostSize,
      'editor',
      env({
        canvasAt: () => ({
          panelId: 'canvas-A',
          rect: rect(0, 0, 1000, 800),
          canvasStoreApi: CANVAS_STORE_A,
        }),
        findOwner: () => ({ nodeId: 'node-A', canvasStoreApi: CANVAS_STORE_A }),
      }),
    )
    expect(t).toMatchObject({
      kind: 'canvas-add',
      canvasStoreApi: CANVAS_STORE_A,
      origin: { x: 300, y: 200 },
    })
  })

  it('applies zoom + viewport offset to origin', () => {
    const cursor = { x: 300, y: 200 }
    const zoomed = fakeCanvasStore(2, { x: 30, y: 40 })
    const t = resolveDrop(
      { client: cursor, screen: cursor, insideWindow: true },
      { ...NODE_SOURCE_A, origin: { kind: 'canvas-node', canvasStoreApi: zoomed, nodeId: 'node-A' } },
      { x: 10, y: 5 },
      ghostSize,
      'editor',
      env({
        canvasAt: () => ({
          panelId: 'canvas-Z',
          rect: rect(10, 20, 1000, 800),
          canvasStoreApi: zoomed,
        }),
      }),
    )
    // localView = (290, 180); canvasCursor = ((290-30)/2, (180-40)/2) = (130, 70)
    // origin = (130-10, 70-5) = (120, 65)
    expect(t).toMatchObject({
      kind: 'canvas-reposition',
      origin: { x: 120, y: 65 },
    })
  })

  it('two adjacent canvases — picks the one canvasAtCursor returns', () => {
    const cursor = { x: 50, y: 50 }
    const t = resolveDrop(
      { client: cursor, screen: cursor, insideWindow: true },
      // Source on canvas B; dropping over canvas A's container.
      { ...NODE_SOURCE_A, origin: { kind: 'canvas-node', canvasStoreApi: CANVAS_STORE_B, nodeId: 'node-on-B' } },
      { x: 0, y: 0 },
      ghostSize,
      'editor',
      env({
        canvasAt: () => ({
          panelId: 'canvas-A',
          rect: rect(0, 0, 500, 500),
          canvasStoreApi: CANVAS_STORE_A,
        }),
      }),
    )
    // Source canvas store !== target canvas store → canvas-add.
    expect((t as { canvasStoreApi?: unknown })?.canvasStoreApi).toBe(CANVAS_STORE_A)
    expect(t?.kind).toBe('canvas-add')
  })

  it('returns null when neither dock nor canvas hit', () => {
    const t = resolveDrop(
      { client: { x: 10, y: 10 }, screen: { x: 10, y: 10 }, insideWindow: true },
      NODE_SOURCE_A,
      grab,
      ghostSize,
      'editor',
      env(),
    )
    expect(t).toBeNull()
  })
})
