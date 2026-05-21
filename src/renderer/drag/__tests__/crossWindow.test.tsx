// =============================================================================
// Cross-window drag integration tests. Drives the bridge in two directions:
//
//   (A) Local drag leaves this window → useDragOp emits a `cross-window-start`
//       effect → electronAPI.crossWindowDragStart fires with the snapshot.
//       Cursor re-enters → electronAPI.crossWindowDragCancel fires.
//
//   (B) Remote drag enters this window → setupCrossWindowDragListeners receives
//       cursor + snapshot via the onCrossWindowDragUpdate handler → dispatches
//       through the *same* runtime as local drags (no parallel state machine).
//       Drop resolves to a target → onDrop callback fires + IPC claim sent.
//
// These tests pin the post-Workstream B contract: remote drags go through
// `reduce`, the legacy `useDragStore.startDrag/updateCursor/setTarget` actions
// are gone, and the only synthetic source-shape is the new `remote` variant.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Heavy renderer-side mocks (must precede the drag/* imports).
vi.mock('../../lib/terminalRegistry', () => ({
  terminalRegistry: { release: vi.fn(), setPendingTransfer: vi.fn() },
}))
vi.mock('../../lib/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}))

import { renderDragScene, type SceneApi } from './harness'
import { setupCrossWindowDragListeners } from '../crossWindow'
import { useDragStore } from '../store'
import { registerDropZone } from '../registry'
import { terminalRegistry } from '../../lib/terminalRegistry'
import type { PanelTransferSnapshot, Point } from '../../../shared/types'

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeSnapshot(over: Partial<PanelTransferSnapshot> = {}): PanelTransferSnapshot {
  return {
    panel: { id: 'remote-panel', type: 'editor', title: 'Remote' },
    geometry: { origin: { x: 0, y: 0 }, size: { width: 300, height: 200 } },
    sourceLocation: { type: 'detached', windowId: 99 },
    ...over,
  } as PanelTransferSnapshot
}

interface ElectronStub {
  crossWindowDragStart: ReturnType<typeof vi.fn>
  crossWindowDragCancel: ReturnType<typeof vi.fn>
  crossWindowDragDrop: ReturnType<typeof vi.fn>
  onCrossWindowDragUpdate: ReturnType<typeof vi.fn>
  onDragEnd: ReturnType<typeof vi.fn>
}

function electronStub(): ElectronStub {
  return window.electronAPI as unknown as ElectronStub
}

/** Mount the bridge and return the handler stashed in onCrossWindowDragUpdate
 *  + the unsubscribe + a setter for the onDragEnd handler. */
function attachBridge(onDrop?: Parameters<typeof setupCrossWindowDragListeners>[0]) {
  const stub = electronStub()
  let updateHandler: ((p: Point, s: PanelTransferSnapshot) => void) | null = null
  let endHandler: (() => void) | null = null
  stub.onCrossWindowDragUpdate.mockImplementation((h: never) => {
    updateHandler = h as never
    return () => {}
  })
  stub.onDragEnd.mockImplementation((h: never) => {
    endHandler = h as never
    return () => {}
  })
  const cleanup = setupCrossWindowDragListeners(onDrop)
  return {
    fireUpdate(screen: Point, snap: PanelTransferSnapshot) {
      if (!updateHandler) throw new Error('onCrossWindowDragUpdate handler not registered')
      updateHandler(screen, snap)
    },
    fireDragEnd() {
      if (!endHandler) throw new Error('onDragEnd handler not registered')
      endHandler()
    },
    cleanup,
  }
}

// -----------------------------------------------------------------------------
// Reset
// -----------------------------------------------------------------------------

let scene: SceneApi | null = null

beforeEach(() => {
  const stub = electronStub()
  stub.crossWindowDragStart.mockClear()
  stub.crossWindowDragCancel.mockClear()
  stub.crossWindowDragDrop.mockClear()
  stub.onCrossWindowDragUpdate.mockClear()
  stub.onDragEnd.mockClear()
})

afterEach(() => {
  scene?.unmount()
  scene = null
})

// -----------------------------------------------------------------------------
// (A) Local-drag boundary crossings
// -----------------------------------------------------------------------------

describe('cross-window — local drag boundary', () => {
  it('cursor leaves window → crossWindowDragStart fired with snapshot', () => {
    const stub = electronStub()
    scene = renderDragScene({
      canvases: [{ panelId: 'c1', rect: { x: 0, y: 0, w: 1000, h: 800 } }],
      nodes: [{ canvasPanelId: 'c1', nodeId: 'n1', origin: { x: 100, y: 100 }, size: { width: 200, height: 150 } }],
    })
    scene.mouse.downOnNode('n1')
    scene.mouse.dragBy({ x: 30, y: 30 }) // arm and move inside
    expect(stub.crossWindowDragStart).not.toHaveBeenCalled()
    // jsdom default innerWidth=1024 — move past the right edge.
    scene.mouse.moveTo({ x: 2000, y: 400 })
    expect(stub.crossWindowDragStart).toHaveBeenCalledTimes(1)
    const call = stub.crossWindowDragStart.mock.calls[0]
    // First arg is the snapshot; second is screen position. We just verify
    // the snapshot has the source panel id.
    expect(call[0]?.panel?.id).toBe('n1')
    scene.mouse.up()
  })

  it('cursor returns to window → crossWindowDragCancel fired', () => {
    const stub = electronStub()
    scene = renderDragScene({
      canvases: [{ panelId: 'c1', rect: { x: 0, y: 0, w: 1000, h: 800 } }],
      nodes: [{ canvasPanelId: 'c1', nodeId: 'n1', origin: { x: 100, y: 100 }, size: { width: 200, height: 150 } }],
    })
    scene.mouse.downOnNode('n1')
    scene.mouse.dragBy({ x: 30, y: 30 })
    scene.mouse.moveTo({ x: 2000, y: 400 }) // leaves window
    expect(stub.crossWindowDragStart).toHaveBeenCalled()
    scene.mouse.moveTo({ x: 500, y: 400 }) // back inside
    expect(stub.crossWindowDragCancel).toHaveBeenCalled()
    scene.mouse.up()
  })
})

// -----------------------------------------------------------------------------
// (B) Remote drag entering this window
// -----------------------------------------------------------------------------

describe('cross-window — remote drag', () => {
  it('first inside-window update STARTs through the runtime (no fake source)', () => {
    const bridge = attachBridge()
    expect(useDragStore.getState().isDragging).toBe(false)

    // Simulate cursor inside this window (screen ≈ client at screenX/Y=0).
    Object.defineProperty(window, 'screenX', { value: 0, configurable: true })
    Object.defineProperty(window, 'screenY', { value: 0, configurable: true })
    bridge.fireUpdate({ x: 400, y: 300 }, makeSnapshot())

    const drag = useDragStore.getState()
    expect(drag.isDragging).toBe(true)
    // The post-migration contract: the source is the new first-class `remote`
    // variant, NOT a synthesized dock-tab with stackId: ''.
    expect(drag.source?.origin.kind).toBe('remote')
    if (drag.source?.origin.kind === 'remote') {
      expect(drag.source.origin.snapshot.panel.id).toBe('remote-panel')
    }
    expect(drag.panel?.id).toBe('remote-panel')

    bridge.cleanup()
  })

  it('outside→inside→outside cycle keeps a single runtime owner', () => {
    const bridge = attachBridge()
    Object.defineProperty(window, 'screenX', { value: 0, configurable: true })
    Object.defineProperty(window, 'screenY', { value: 0, configurable: true })

    // First update with cursor OUTSIDE this window — should NOT start a drag.
    bridge.fireUpdate({ x: -100, y: -100 }, makeSnapshot())
    expect(useDragStore.getState().isDragging).toBe(false)

    // Now enter the window.
    bridge.fireUpdate({ x: 400, y: 300 }, makeSnapshot())
    expect(useDragStore.getState().isDragging).toBe(true)

    // Move outside again — drag is still active (the runtime keeps state)
    // but the target should clear.
    bridge.fireUpdate({ x: -100, y: -100 }, makeSnapshot())
    const after = useDragStore.getState()
    expect(after.isDragging).toBe(true)
    expect(after.target).toBeNull()

    bridge.cleanup()
  })

  it('drop on a registered dock zone → onDrop fires + IPC claim sent', () => {
    const stub = electronStub()
    const onDrop = vi.fn()
    const bridge = attachBridge(onDrop)

    // Register a drop zone covering (200..600, 200..600). `dockStoreApi` is
    // required by resolveDrop to produce a dock-zone target — pass a minimal
    // shim (the bridge only forwards it to the host onDrop, which we mock).
    const fakeDockStore = {
      getState() { return {} },
      setState() {},
      subscribe() { return () => {} },
      destroy() {},
    } as unknown as Parameters<typeof registerDropZone>[0]['dockStoreApi']
    const cleanup = registerDropZone({
      id: 'test-zone',
      zone: 'left',
      dockStoreApi: fakeDockStore,
      getRect: () => ({
        x: 200, y: 200, left: 200, top: 200, right: 600, bottom: 600,
        width: 400, height: 400, toJSON() { return {} },
      } as DOMRect),
    })

    Object.defineProperty(window, 'screenX', { value: 0, configurable: true })
    Object.defineProperty(window, 'screenY', { value: 0, configurable: true })

    // Enter — first update inside the window AND inside the drop zone.
    bridge.fireUpdate({ x: 400, y: 400 }, makeSnapshot())
    const mid = useDragStore.getState()
    expect(mid.isDragging).toBe(true)
    expect(mid.target).not.toBeNull()
    expect(mid.target?.kind === 'dock-zone' || mid.target?.kind === 'dock-tab').toBe(true)

    // Drop.
    bridge.fireDragEnd()

    expect(onDrop).toHaveBeenCalledTimes(1)
    const dropArg = onDrop.mock.calls[0][1]
    expect(dropArg.kind).toBe('dock')
    expect(stub.crossWindowDragDrop).toHaveBeenCalledWith('remote-panel')
    // Runtime should have cleared state.
    expect(useDragStore.getState().isDragging).toBe(false)

    cleanup()
    bridge.cleanup()
  })

  it('drop on a per-canvas-node mini-dock → onDrop receives that store reference', () => {
    const stub = electronStub()
    const onDrop = vi.fn()
    const bridge = attachBridge(onDrop)

    // A distinct fake store representing a canvas-node mini-dock (NOT the
    // global main useDockStore). The bridge must forward this reference so
    // the host can route the drop to the correct DockStore.
    const fakeNodeDockStore = {
      getState() { return {} },
      setState() {},
      subscribe() { return () => {} },
      destroy() {},
    } as unknown as Parameters<typeof registerDropZone>[0]['dockStoreApi']
    const cleanup = registerDropZone({
      id: 'node-mini-dock-zone',
      zone: 'center',
      dockStoreApi: fakeNodeDockStore,
      getRect: () => ({
        x: 200, y: 200, left: 200, top: 200, right: 600, bottom: 600,
        width: 400, height: 400, toJSON() { return {} },
      } as DOMRect),
    })

    Object.defineProperty(window, 'screenX', { value: 0, configurable: true })
    Object.defineProperty(window, 'screenY', { value: 0, configurable: true })

    bridge.fireUpdate({ x: 400, y: 400 }, makeSnapshot())
    bridge.fireDragEnd()

    expect(onDrop).toHaveBeenCalledTimes(1)
    const dropArg = onDrop.mock.calls[0][1]
    expect(dropArg.kind).toBe('dock')
    expect(dropArg.dockStoreApi).toBe(fakeNodeDockStore)
    expect(stub.crossWindowDragDrop).toHaveBeenCalledWith('remote-panel')

    cleanup()
    bridge.cleanup()
  })

  it('drop on canvas surface → onDrop fires with canvas target + IPC claim sent', () => {
    const stub = electronStub()
    const onDrop = vi.fn()
    const bridge = attachBridge(onDrop)

    // Mount a real canvas via the harness so resolveDrop's
    // defaultDropEnvironment.canvasAtCursor finds a [data-canvas-container].
    scene = renderDragScene({
      canvases: [{ panelId: 'c1', rect: { x: 0, y: 0, w: 1000, h: 800 } }],
    })

    Object.defineProperty(window, 'screenX', { value: 0, configurable: true })
    Object.defineProperty(window, 'screenY', { value: 0, configurable: true })

    bridge.fireUpdate({ x: 400, y: 300 }, makeSnapshot())
    const mid = useDragStore.getState()
    expect(mid.isDragging).toBe(true)
    expect(mid.target?.kind).toBe('canvas-add')

    bridge.fireDragEnd()

    expect(onDrop).toHaveBeenCalledTimes(1)
    const dropArg = onDrop.mock.calls[0][1]
    expect(dropArg.kind).toBe('canvas')
    expect(dropArg.canvasStoreApi).toBeTruthy()
    expect(stub.crossWindowDragDrop).toHaveBeenCalledWith('remote-panel')

    bridge.cleanup()
  })

  it('terminal snapshot drop deposits PTY transfer before any host mutation', () => {
    const setPending = terminalRegistry.setPendingTransfer as ReturnType<typeof vi.fn>
    setPending.mockClear()
    const callOrder: string[] = []
    setPending.mockImplementation(() => {
      callOrder.push('setPendingTransfer')
    })

    const onDrop = vi.fn((_snapshot: PanelTransferSnapshot, _target: unknown) => {
      callOrder.push('onDrop')
    })
    const bridge = attachBridge((snapshot, target) => {
      // Simulate the host: it must call setPendingTransfer BEFORE registering
      // the panel. Here we just record the order — the bridge itself only
      // forwards to the host, but the host invocation order is what matters.
      if (snapshot.terminalPtyId) {
        terminalRegistry.setPendingTransfer(
          snapshot.panel.id,
          snapshot.terminalPtyId,
          snapshot.terminalScrollback,
        )
      }
      onDrop(snapshot, target)
    })

    scene = renderDragScene({
      canvases: [{ panelId: 'c1', rect: { x: 0, y: 0, w: 1000, h: 800 } }],
    })

    Object.defineProperty(window, 'screenX', { value: 0, configurable: true })
    Object.defineProperty(window, 'screenY', { value: 0, configurable: true })

    const termSnap = makeSnapshot({
      panel: { id: 'remote-term', type: 'terminal', title: 'Term' },
      terminalPtyId: 'pty-123',
      terminalScrollback: 'last output',
    } as Partial<PanelTransferSnapshot>)

    bridge.fireUpdate({ x: 400, y: 300 }, termSnap)
    bridge.fireDragEnd()

    expect(setPending).toHaveBeenCalledWith(
      'remote-term',
      'pty-123',
      'last output',
    )
    expect(callOrder[0]).toBe('setPendingTransfer')
    expect(callOrder[1]).toBe('onDrop')

    bridge.cleanup()
  })

  it('drop with no target → no onDrop + no claim + state cleared', () => {
    const stub = electronStub()
    const onDrop = vi.fn()
    const bridge = attachBridge(onDrop)

    Object.defineProperty(window, 'screenX', { value: 0, configurable: true })
    Object.defineProperty(window, 'screenY', { value: 0, configurable: true })

    // Enter, but with no drop zones registered, the target stays null.
    bridge.fireUpdate({ x: 400, y: 300 }, makeSnapshot())
    expect(useDragStore.getState().target).toBeNull()

    bridge.fireDragEnd()
    expect(onDrop).not.toHaveBeenCalled()
    expect(stub.crossWindowDragDrop).not.toHaveBeenCalled()
    expect(useDragStore.getState().isDragging).toBe(false)

    bridge.cleanup()
  })

  it('cleanup mid-drag cancels the runtime (no leaked state)', () => {
    const bridge = attachBridge()
    Object.defineProperty(window, 'screenX', { value: 0, configurable: true })
    Object.defineProperty(window, 'screenY', { value: 0, configurable: true })

    bridge.fireUpdate({ x: 400, y: 300 }, makeSnapshot())
    expect(useDragStore.getState().isDragging).toBe(true)
    bridge.cleanup()
    expect(useDragStore.getState().isDragging).toBe(false)
  })
})
