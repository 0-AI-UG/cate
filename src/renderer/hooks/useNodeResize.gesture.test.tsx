// =============================================================================
// useNodeResize — gesture orchestration tests.
//
// These pin the wiring that the snap-to-grid branch changed and that the pure
// snapResizeDelta tests (layoutEngine.test.ts) can't reach:
//   - grid snapping is deferred from per-mousemove to release, so the edge
//     tracks the cursor 1:1 during the drag;
//   - a bare click on a resize edge (mousedown → mouseup, no move) is a no-op,
//     even when it would otherwise snap a non-grid-aligned edge;
//   - holding Alt at release bypasses snapping;
//   - shared-border neighbors snap together with the primary node on release.
//
// Driven through real DOM events (mousedown on the rendered handle → React's
// synthetic onMouseDown; window mousemove/mouseup caught by the hook's own
// listeners), mirroring src/renderer/drag/__tests__/harness.tsx. Only the
// requestAnimationFrame pump is stubbed so the live commit is deterministic.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock heavy renderer-side modules whose import-time side effects (xterm,
// electron-log) explode under jsdom — useNodeResize pulls them in transitively
// via the canvas/app stores. Mirrors drag/__tests__/scenarios.test.tsx.
vi.mock('../lib/terminalRegistry', () => ({
  terminalRegistry: { release: vi.fn() },
}))
vi.mock('../lib/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}))

import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { StoreApi } from 'zustand'
import { useNodeResize, type ResizeEdge } from './useNodeResize'
import {
  getOrCreateCanvasStoreForPanel,
  releaseCanvasStoreForPanel,
  type CanvasStore,
} from '../stores/canvasStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { PanelType, Point, Size } from '../../shared/types'

// -----------------------------------------------------------------------------
// RAF pump. useNodeResize commits live drag geometry inside a
// requestAnimationFrame callback; capturing it (instead of letting jsdom's
// timer-backed RAF fire) lets a test flush that commit synchronously. The
// mouseup handler flushes its pending geometry on its own, so assertions taken
// after release don't need flushRaf().
// -----------------------------------------------------------------------------

let rafCb: FrameRequestCallback | null = null
function flushRaf() {
  const cb = rafCb
  rafCb = null
  if (cb) cb(0)
}

// -----------------------------------------------------------------------------
// Scene
// -----------------------------------------------------------------------------

interface NodeInit {
  id: string
  panelType?: PanelType
  origin: Point
  size: Size
}

let container: HTMLDivElement
let root: Root
let sceneCounter = 0
const releaseStore: Array<() => void> = []

function ResizeProbe({
  nodeId,
  edge,
  panelType,
  store,
}: {
  nodeId: string
  edge: ResizeEdge
  panelType: PanelType
  store: StoreApi<CanvasStore>
}) {
  const { handleResizeStart } = useNodeResize(nodeId, panelType, store)
  return <div data-testid="handle" onMouseDown={(e) => handleResizeStart(e, edge)} />
}

/** Register `nodes` in a fresh canvas store and render a resize handle wired to
 *  `probe`. Origins/sizes are forced exactly (addNode may clamp/default). */
function setupScene(
  nodes: NodeInit[],
  probe: { nodeId: string; edge: ResizeEdge; panelType?: PanelType },
): StoreApi<CanvasStore> {
  const panelId = `resize-test-${sceneCounter++}`
  const store = getOrCreateCanvasStoreForPanel(panelId)
  releaseStore.push(() => releaseCanvasStoreForPanel(panelId))

  act(() => {
    store.getState().setZoomAndOffset(1, { x: 0, y: 0 })
    for (const n of nodes) {
      const created = store.getState().addNode(`panel-${n.id}`, n.panelType ?? 'editor', n.origin, n.size)
      store.setState((s) => {
        const node = s.nodes[created]
        if (!node) return s
        const next = { ...s.nodes }
        delete next[created]
        next[n.id] = { ...node, id: n.id, origin: { ...n.origin }, size: { ...n.size } }
        return { ...s, nodes: next }
      })
    }
  })

  act(() => {
    root.render(
      <ResizeProbe
        nodeId={probe.nodeId}
        edge={probe.edge}
        panelType={probe.panelType ?? 'editor'}
        store={store}
      />,
    )
  })
  return store
}

// -----------------------------------------------------------------------------
// Mouse driver
// -----------------------------------------------------------------------------

function down(clientX: number, clientY: number) {
  const handle = container.querySelector<HTMLElement>('[data-testid="handle"]')
  if (!handle) throw new Error('resize handle not rendered')
  act(() => {
    handle.dispatchEvent(
      new MouseEvent('mousedown', { clientX, clientY, button: 0, bubbles: true }),
    )
  })
}

function move(clientX: number, clientY: number) {
  act(() => {
    window.dispatchEvent(new MouseEvent('mousemove', { clientX, clientY, bubbles: true }))
  })
}

function up(clientX: number, clientY: number, opts: { altKey?: boolean } = {}) {
  act(() => {
    window.dispatchEvent(
      new MouseEvent('mouseup', { clientX, clientY, altKey: opts.altKey ?? false, bubbles: true }),
    )
  })
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafCb = cb
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', () => {
    rafCb = null
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container)
  })
  useSettingsStore.setState({ snapToGrid: false })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  rafCb = null
  vi.unstubAllGlobals()
  while (releaseStore.length) releaseStore.pop()!()
})

describe('useNodeResize — gesture', () => {
  it('tracks the cursor 1:1 during the drag even when snap-to-grid is on', () => {
    useSettingsStore.setState({ snapToGrid: true })
    // Right edge at x = 100 + 500 = 600.
    const store = setupScene(
      [{ id: 'A', origin: { x: 100, y: 100 }, size: { width: 500, height: 400 } }],
      { nodeId: 'A', edge: 'right' },
    )

    down(600, 300)
    move(613, 300) // +13 px — deliberately off the 20-px grid
    flushRaf() // commit the live (RAF-scheduled) geometry

    // Mid-drag the width follows the cursor exactly; snapping has NOT run yet.
    expect(store.getState().nodes['A'].size.width).toBe(513)

    up(613, 300) // detach listeners (snaps on release, already asserted above)
  })

  it('snaps the moving edge to the grid on release', () => {
    useSettingsStore.setState({ snapToGrid: true })
    const store = setupScene(
      [{ id: 'A', origin: { x: 100, y: 100 }, size: { width: 500, height: 400 } }],
      { nodeId: 'A', edge: 'right' },
    )

    down(600, 300)
    move(613, 300)
    up(613, 300)

    // Right edge 613 → nearest grid line 620 → width 520.
    expect(store.getState().nodes['A'].size.width).toBe(520)
    expect(store.getState().nodes['A'].origin).toEqual({ x: 100, y: 100 })
  })

  it('bare click on a resize edge is a no-op (no snap without movement)', () => {
    useSettingsStore.setState({ snapToGrid: true })
    // Right edge at x = 605 — deliberately off-grid. Were snapping to run on a
    // zero-length gesture it would pull the edge to 600 (width 500).
    const store = setupScene(
      [{ id: 'A', origin: { x: 100, y: 100 }, size: { width: 505, height: 400 } }],
      { nodeId: 'A', edge: 'right' },
    )

    down(605, 300)
    up(605, 300) // no mousemove

    expect(store.getState().nodes['A'].size).toEqual({ width: 505, height: 400 })
    expect(store.getState().nodes['A'].origin).toEqual({ x: 100, y: 100 })
  })

  it('Alt held at release bypasses grid snapping', () => {
    useSettingsStore.setState({ snapToGrid: true })
    const store = setupScene(
      [{ id: 'A', origin: { x: 100, y: 100 }, size: { width: 500, height: 400 } }],
      { nodeId: 'A', edge: 'right' },
    )

    down(600, 300)
    move(613, 300)
    up(613, 300, { altKey: true })

    // Alt bypasses the snap → the raw +13 delta is committed unrounded.
    expect(store.getState().nodes['A'].size.width).toBe(513)
  })

  it('snaps a shared-border neighbor together with the primary on release', () => {
    useSettingsStore.setState({ snapToGrid: true })
    // A.right and B.left share the border at x = 500 over the y-range [100,500].
    const store = setupScene(
      [
        { id: 'A', origin: { x: 100, y: 100 }, size: { width: 400, height: 400 } },
        { id: 'B', origin: { x: 500, y: 100 }, size: { width: 700, height: 400 } },
      ],
      { nodeId: 'A', edge: 'right' },
    )

    down(500, 300)
    move(513, 300)
    up(513, 300)

    // Shared border 513 → snaps to 520. A grows by 20, B shrinks by 20; both
    // edges land on the same grid line.
    const a = store.getState().nodes['A']
    const b = store.getState().nodes['B']
    expect(a.size.width).toBe(420) // right edge 520
    expect(b.origin.x).toBe(520) // left edge follows
    expect(b.size.width).toBe(680)
    expect(b.size.height).toBe(400) // untouched on the orthogonal axis
  })
})
