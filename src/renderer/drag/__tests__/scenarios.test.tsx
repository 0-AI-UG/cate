// =============================================================================
// Integration scenarios — pins user-visible drag behavior so future refactors
// can't silently break it. Each test exercises real useDragOp → runtime →
// resolve → commit. Only window.electronAPI is mocked.
//
// Numbered scenarios match Phase 1 of the plan. Dock-related scenarios (6, 7,
// 10) require dock-stack support in the harness and are skipped pending a
// follow-up harness extension. preMaximizeSize / proportional grab / cross-
// store invariant are the high-priority regressions targeted here.
// =============================================================================

import { describe, it, expect, vi, afterEach } from 'vitest'

// Mock heavy renderer-side modules whose import-time side effects (xterm,
// electron-log) explode under jsdom. The drag dispatcher only needs these for
// real-window code paths that the harness doesn't exercise.
vi.mock('../../lib/terminalRegistry', () => ({
  terminalRegistry: { release: vi.fn() },
}))
vi.mock('../../lib/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}))

import { renderDragScene, type SceneApi } from './harness'

let scene: SceneApi | null = null

afterEach(() => {
  scene?.unmount()
  scene = null
})

describe('drag integration — canvas-node scenarios', () => {
  // ---------------------------------------------------------------------------
  // 1. Move within canvas at zoom=1 — origin updates by exact delta.
  // ---------------------------------------------------------------------------
  it('1: moves a node by exact client delta at zoom=1', () => {
    scene = renderDragScene({
      canvases: [{ panelId: 'c1', rect: { x: 0, y: 0, w: 1000, h: 800 } }],
      nodes: [{ canvasPanelId: 'c1', nodeId: 'n1', origin: { x: 100, y: 100 }, size: { width: 200, height: 150 } }],
    })
    const store = scene.getCanvasStore('c1')
    scene.mouse.downOnNode('n1')
    scene.mouse.moveBy({ x: 50, y: 30 })
    scene.mouse.moveBy({ x: 10, y: 10 }) // beyond dead zone
    scene.mouse.up()
    const node = store.getState().nodes['n1']
    // Delta should be (60, 40) — minus any rounding in the canvas store.
    expect(node.origin.x).toBeCloseTo(160, 0)
    expect(node.origin.y).toBeCloseTo(140, 0)
  })

  // ---------------------------------------------------------------------------
  // 2. Move at zoom=0.5 — canvas-space delta = screen delta ÷ zoom.
  // ---------------------------------------------------------------------------
  it('2a: at zoom=0.5, a 100px screen delta becomes a 200-unit canvas delta', () => {
    scene = renderDragScene({
      canvases: [{ panelId: 'c1', rect: { x: 0, y: 0, w: 1000, h: 800 }, zoom: 0.5 }],
      nodes: [{ canvasPanelId: 'c1', nodeId: 'n1', origin: { x: 100, y: 100 }, size: { width: 200, height: 150 } }],
    })
    const store = scene.getCanvasStore('c1')
    scene.mouse.downOnNode('n1')
    scene.mouse.moveBy({ x: 100, y: 0 })
    scene.mouse.moveBy({ x: 10, y: 0 })
    scene.mouse.up()
    const node = store.getState().nodes['n1']
    expect(node.origin.x).toBeCloseTo(100 + (100 + 10) / 0.5, 0)
  })

  it('2b: at zoom=2, a 100px screen delta becomes a 50-unit canvas delta', () => {
    scene = renderDragScene({
      canvases: [{ panelId: 'c1', rect: { x: 0, y: 0, w: 1000, h: 800 }, zoom: 2 }],
      nodes: [{ canvasPanelId: 'c1', nodeId: 'n1', origin: { x: 100, y: 100 }, size: { width: 200, height: 150 } }],
    })
    const store = scene.getCanvasStore('c1')
    scene.mouse.downOnNode('n1')
    scene.mouse.moveBy({ x: 100, y: 0 })
    scene.mouse.moveBy({ x: 10, y: 0 })
    scene.mouse.up()
    const node = store.getState().nodes['n1']
    expect(node.origin.x).toBeCloseTo(100 + (100 + 10) / 2, 0)
  })

  // ---------------------------------------------------------------------------
  // 3. Dead-zone — 3px movement does not start a drag, does not push history.
  // ---------------------------------------------------------------------------
  it('3: a 3px nudge does not arm the drag', () => {
    scene = renderDragScene({
      canvases: [{ panelId: 'c1', rect: { x: 0, y: 0, w: 1000, h: 800 } }],
      nodes: [{ canvasPanelId: 'c1', nodeId: 'n1', origin: { x: 100, y: 100 }, size: { width: 200, height: 150 } }],
    })
    const store = scene.getCanvasStore('c1')
    const initialOrigin = { ...store.getState().nodes['n1'].origin }
    scene.mouse.downOnNode('n1')
    scene.mouse.moveBy({ x: 3, y: 0 })
    scene.mouse.up()
    expect(scene.drag().isDragging).toBe(false)
    expect(store.getState().nodes['n1'].origin).toEqual(initialOrigin)
  })

  // ---------------------------------------------------------------------------
  // 4. preMaximizeSize ghost sizing — drag a maximized node; ghost size =
  //    preMaximizeSize, not the current (maximized) size. Lost in 0.4.4.
  // ---------------------------------------------------------------------------
  it('4: ghost size for a maximized node equals preMaximizeSize', () => {
    scene = renderDragScene({
      canvases: [{ panelId: 'c1', rect: { x: 0, y: 0, w: 1000, h: 800 } }],
      nodes: [{
        canvasPanelId: 'c1',
        nodeId: 'n1',
        origin: { x: 0, y: 0 },
        size: { width: 1000, height: 800 }, // maximized
        preMaximizeOrigin: { x: 200, y: 150 },
        preMaximizeSize: { width: 300, height: 200 },
      }],
    })
    scene.mouse.downOnNode('n1', { offset: { x: 500, y: 400 } })
    scene.mouse.moveBy({ x: 50, y: 50 })
    const drag = scene.drag()
    expect(drag.isDragging).toBe(true)
    expect(drag.ghostSize?.width).toBe(300)
    expect(drag.ghostSize?.height).toBe(200)
    scene.mouse.up()
  })

  // ---------------------------------------------------------------------------
  // 5. Proportional grab on maximized node — cursor lands at same relative
  //    fraction inside the smaller ghost.
  // ---------------------------------------------------------------------------
  it('5: grab on a maximized node is projected proportionally into the pre-maximize rect', () => {
    scene = renderDragScene({
      canvases: [{ panelId: 'c1', rect: { x: 0, y: 0, w: 1000, h: 800 } }],
      nodes: [{
        canvasPanelId: 'c1',
        nodeId: 'n1',
        origin: { x: 0, y: 0 },
        size: { width: 1000, height: 800 },
        preMaximizeOrigin: { x: 0, y: 0 },
        preMaximizeSize: { width: 300, height: 200 },
      }],
    })
    // Grab at (750, 600): fraction (0.75, 0.75) of the maximized footprint.
    scene.mouse.downOnNode('n1', { offset: { x: 750, y: 600 } })
    scene.mouse.moveBy({ x: 10, y: 10 })
    const drag = scene.drag()
    expect(drag.isDragging).toBe(true)
    // Expected grab = 0.75 × ghostSize.
    expect(drag.grab?.x).toBeCloseTo(0.75 * 300, 0)
    expect(drag.grab?.y).toBeCloseTo(0.75 * 200, 0)
  })

  // ---------------------------------------------------------------------------
  // 8. Cross-store invariant — drop from canvas A onto canvas B: the resolved
  //    target's canvasStoreApi must match canvas B's store, not A's. The
  //    historic bug was findCanvasStoreForNode returning a stale match.
  // ---------------------------------------------------------------------------
  it('8: dropping across two canvases routes commit to the destination store', () => {
    scene = renderDragScene({
      canvases: [
        { panelId: 'cA', rect: { x: 0, y: 0, w: 400, h: 800 } },
        { panelId: 'cB', rect: { x: 500, y: 0, w: 400, h: 800 } },
      ],
      nodes: [{ canvasPanelId: 'cA', nodeId: 'na', origin: { x: 10, y: 10 }, size: { width: 100, height: 80 } }],
    })
    const a = scene.getCanvasStore('cA')
    const b = scene.getCanvasStore('cB')
    scene.mouse.downOnNode('na')
    // Move into the cB rect.
    scene.mouse.moveTo({ x: 600, y: 400 })
    scene.mouse.moveBy({ x: 5, y: 5 })
    scene.mouse.up()
    // Source removed from cA, new node in cB.
    expect(Object.keys(a.getState().nodes)).not.toContain('na')
    expect(Object.values(b.getState().nodes).length).toBeGreaterThan(0)
  })

  // ---------------------------------------------------------------------------
  // 9. Source visibility — during a whole-node drag, the drag store reports
  //    the source so the (yet-to-be-introduced) useDragSourceVisibility hook
  //    has a single derivation. Phase 1 only pins the state shape; Phase 2
  //    consolidates the application sites.
  // ---------------------------------------------------------------------------
  it('9: while dragging, drag.source identifies the source node by id', () => {
    scene = renderDragScene({
      canvases: [{ panelId: 'c1', rect: { x: 0, y: 0, w: 1000, h: 800 } }],
      nodes: [{ canvasPanelId: 'c1', nodeId: 'n1', origin: { x: 100, y: 100 }, size: { width: 200, height: 150 } }],
    })
    scene.mouse.downOnNode('n1')
    scene.mouse.moveBy({ x: 10, y: 10 })
    const drag = scene.drag()
    expect(drag.isDragging).toBe(true)
    expect(drag.source?.origin.kind).toBe('canvas-node')
    if (drag.source?.origin.kind === 'canvas-node') {
      expect(drag.source.origin.nodeId).toBe('n1')
    }
    scene.mouse.up()
    expect(scene.drag().isDragging).toBe(false)
    expect(scene.drag().source).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // 12. Cancel via blur — mid-drag blur clears state.
  // ---------------------------------------------------------------------------
  it('12: window blur mid-drag clears drag state', () => {
    scene = renderDragScene({
      canvases: [{ panelId: 'c1', rect: { x: 0, y: 0, w: 1000, h: 800 } }],
      nodes: [{ canvasPanelId: 'c1', nodeId: 'n1', origin: { x: 100, y: 100 }, size: { width: 200, height: 150 } }],
    })
    scene.mouse.downOnNode('n1')
    scene.mouse.moveBy({ x: 20, y: 20 })
    expect(scene.drag().isDragging).toBe(true)
    scene.mouse.blur()
    expect(scene.drag().isDragging).toBe(false)
    expect(scene.drag().source).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // 11. Detach into new window — drag a canvas-node past the window edge and
  //     mouseup outside. Runtime emits a `detach` target; commitDrop calls
  //     crossWindowResolve (no claim) and then dragDetach to spawn a window.
  // ---------------------------------------------------------------------------
  it('11: drop outside window triggers dragDetach + removes source', async () => {
    const electronAPI = window.electronAPI as unknown as {
      crossWindowDragStart: ReturnType<typeof vi.fn>
      crossWindowDragResolve: ReturnType<typeof vi.fn>
      dragDetach: ReturnType<typeof vi.fn>
    }
    electronAPI.crossWindowDragResolve.mockResolvedValueOnce({ claimed: false })
    electronAPI.dragDetach.mockResolvedValueOnce(42)

    scene = renderDragScene({
      canvases: [{ panelId: 'c1', rect: { x: 0, y: 0, w: 1000, h: 800 } }],
      nodes: [{ canvasPanelId: 'c1', nodeId: 'n1', origin: { x: 100, y: 100 }, size: { width: 200, height: 150 } }],
    })
    const store = scene.getCanvasStore('c1')
    scene.mouse.downOnNode('n1')
    scene.mouse.dragBy({ x: 60, y: 60 }) // arm + move inside
    // Move past the right window edge (jsdom default innerWidth = 1024).
    scene.mouse.moveTo({ x: 2000, y: 400 })
    scene.mouse.up()
    // commitDrop is async (two awaits: crossWindowResolve, then dragDetach).
    // Yield enough microtasks for both to resolve.
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(electronAPI.crossWindowDragStart).toHaveBeenCalled()
    expect(electronAPI.crossWindowDragResolve).toHaveBeenCalled()
    expect(electronAPI.dragDetach).toHaveBeenCalled()
    expect(Object.keys(store.getState().nodes)).not.toContain('n1')
  })

  // ---------------------------------------------------------------------------
  // 13. Race — a second mousedown while a drag is active is ignored (the
  //     handleDragStart guard at useDragOp.ts:457). Pinned so a refactor that
  //     drops the guard fails loudly.
  // ---------------------------------------------------------------------------
  it('13: second mousedown during active drag is ignored', () => {
    scene = renderDragScene({
      canvases: [{ panelId: 'c1', rect: { x: 0, y: 0, w: 1000, h: 800 } }],
      nodes: [
        { canvasPanelId: 'c1', nodeId: 'n1', origin: { x: 100, y: 100 }, size: { width: 100, height: 80 } },
        { canvasPanelId: 'c1', nodeId: 'n2', origin: { x: 400, y: 400 }, size: { width: 100, height: 80 } },
      ],
    })
    scene.mouse.downOnNode('n1')
    scene.mouse.moveBy({ x: 10, y: 10 })
    // Drag is active on n1. A second mousedown on n2 must NOT take over.
    scene.mouse.downOnNode('n2')
    const drag = scene.drag()
    expect(drag.isDragging).toBe(true)
    if (drag.source?.origin.kind === 'canvas-node') {
      expect(drag.source.origin.nodeId).toBe('n1')
    }
    scene.mouse.up()
  })

  // ---------------------------------------------------------------------------
  // 14. Race — mouseup followed by another mouseup is a no-op (the dispatcher
  //     detaches its listeners on the first mouseup; the runtime's END is
  //     idempotent on un-armed state).
  // ---------------------------------------------------------------------------
  it('14: mouseup after a completed drag is a no-op', () => {
    scene = renderDragScene({
      canvases: [{ panelId: 'c1', rect: { x: 0, y: 0, w: 1000, h: 800 } }],
      nodes: [{ canvasPanelId: 'c1', nodeId: 'n1', origin: { x: 100, y: 100 }, size: { width: 100, height: 80 } }],
    })
    scene.mouse.downOnNode('n1')
    scene.mouse.dragBy({ x: 30, y: 30 })
    scene.mouse.up()
    expect(scene.drag().isDragging).toBe(false)
    // Second mouseup — should not throw, should not toggle isDragging back.
    scene.mouse.up()
    expect(scene.drag().isDragging).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // 6, 7, 10 — require a real DockStore/DockTabStack mounted in the harness
  // (a multi-tab stack with registered drop zones, undockPanel/dockPanel store
  // actions, and a separate per-node mini-dock for scenario 10). That is
  // substantially more harness scaffolding than this file owns. They remain
  // skipped here until a dock harness is added.
  // ---------------------------------------------------------------------------
  it.skip('6: single-tab self-drop guard (requires dock harness)', () => {})
  it.skip('7: tab detach from multi-tab stack (requires dock harness)', () => {})
  it.skip('10: spring-load on maximized (requires dock harness + fake timers)', () => {})
})
