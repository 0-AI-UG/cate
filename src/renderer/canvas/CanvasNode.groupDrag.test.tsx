// =============================================================================
// CanvasNode group-drag regression — pins that grabbing a selected panel routes
// to a GROUP drag through the unified drag engine (it carries the whole
// selection), not a single-node move.
//
// A multi-selection is never "activated", so no node is focused and every node
// renders its dim overlay. Pressing a member must dispatch a canvas-node drag
// whose source carries the other selected nodes (`members`). The hazard this
// guards against: the dock-content wrapper has a CAPTURE-phase mousedown handler
// that focuses the node, and capture runs BEFORE the bubble-phase tab-bar
// handler that starts the drag. If that capture handler focuses unconditionally
// it collapses the selection to the grabbed node (focusNode → selection=[id])
// before handleDragStart reads it — so the drag sees a single-node selection and
// only the grabbed panel would move.
//
// Group MOVEMENT itself (members translate by the snapped delta on drop) is an
// integration concern of the drag engine and is covered end-to-end in
// drag/__tests__/scenarios.test.tsx (scenario 1c) + the resolve/commit unit
// tests. Here we render the REAL CanvasNode and assert the dispatch wiring: a
// mousedown on the `.dock-tab-bar` arms a drag whose published source carries
// `members`, and the selection is not collapsed. The only faked surface is
// terminalRegistry (import-time side effects explode under jsdom).
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../lib/terminal/terminalRegistry', () => ({
  terminalRegistry: {
    release: vi.fn(),
    dispose: vi.fn(),
    disposeWorkspace: vi.fn(),
    has: () => false,
    getEntry: () => undefined,
  },
}))

// WorktreePill (rendered inside the tab bar) calls useWorktrees, which arms a
// git-status fs-watch subscription via electronAPI — irrelevant to this test
// and a jsdom landmine. Stub it to a no-op empty list.
vi.mock('../stores/useWorktrees', () => ({
  useWorktrees: () => [],
}))

import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import type { StoreApi } from 'zustand'
import CanvasNode from './CanvasNode'
import { CanvasStoreProvider } from '../stores/CanvasStoreContext'
import { createCanvasStore, type CanvasStore } from '../stores/canvasStore'
import { createDockStore, createDefaultDockState, type DockStore } from '../stores/dockStore'
import { useAppStore } from '../stores/appStore'
import { useDragStore } from '../drag'
import { getDefaultSession } from '../drag/session'
import { INITIAL_DRAG_STATE } from '../drag/types'
import type { Point, Size, WindowDockState } from '../../shared/types'

// -----------------------------------------------------------------------------
// Scaffolding
// -----------------------------------------------------------------------------

let container: HTMLDivElement
let root: Root

function freshCanvasStore(): StoreApi<CanvasStore> {
  const store = createCanvasStore()
  act(() => store.getState().setZoomAndOffset(1, { x: 0, y: 0 }))
  return store
}

// Add a node with an explicit id, origin and size — and force animationState to
// 'idle' so CanvasNode's entering-animation rAF effect doesn't run.
function addNode(store: StoreApi<CanvasStore>, id: string, panelId: string, origin: Point, size: Size) {
  act(() => {
    const created = store.getState().addNode(panelId, 'editor', origin, size)
    store.setState((s) => {
      const node = s.nodes[created]
      if (!node) return s
      const next = { ...s.nodes }
      delete next[created]
      next[id] = { ...node, id, origin: { ...origin }, size: { ...size }, animationState: 'idle' }
      return { ...s, nodes: next }
    })
  })
}

// A per-node dock store whose center zone is a single-tab stack — this is what
// makes CanvasNode render its header tab bar (rootIsTabs) wired to the group
// drag handler.
function tabsDockStore(panelId: string): StoreApi<DockStore> {
  const zones: WindowDockState = {
    ...createDefaultDockState(),
    center: {
      position: 'center',
      visible: true,
      size: 0,
      layout: { type: 'tabs', id: `stack-${panelId}`, panelIds: [panelId], activeIndex: 0 },
    },
  }
  return createDockStore({ zones })
}

beforeEach(() => {
  // A workspace that backs the rendered node's panel (CanvasNode derives its
  // primaryPanel from the active workspace). Reset directly so addWorkspace
  // auto-selects the fresh one (it only auto-selects when none exist).
  useAppStore.setState({ workspaces: [], selectedWorkspaceId: '' })
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => { root = createRoot(container) })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.classList.remove('canvas-interacting', 'canvas-dragging')
  // Tests below leave a drag armed (mousedown without mouseup); reset the
  // singleton dispatch + published state so they don't leak into the next test.
  getDefaultSession().resetDispatch()
  useDragStore.getState().applyDragState(INITIAL_DRAG_STATE)
})

function dispatchMouse(el: EventTarget, type: string, client: Point, button = 0) {
  act(() => {
    el.dispatchEvent(new MouseEvent(type, {
      button,
      clientX: client.x,
      clientY: client.y,
      bubbles: true,
    }))
  })
}

// =============================================================================

describe('CanvasNode — file drags into an unfocused webview', () => {
  it.each(['agent', 'browser'] as const)('keeps the %s overlay transparent across the guest boundary and restores it after leaving or dropping', (type) => {
    const wsId = useAppStore.getState().addWorkspace('WS', '/tmp/ws', 'ws-file-drag')
    useAppStore.getState().addPanel(wsId, { id: 'panel-A', type, title: type, isDirty: false })
    const store = freshCanvasStore()
    addNode(store, 'A', 'panel-A', { x: 0, y: 0 }, { width: 200, height: 150 })
    act(() => root.render(
      <CanvasStoreProvider store={store}>
        <CanvasNode nodeId="A" isFocused={false} dockStoreApi={tabsDockStore('panel-A')}
          renderPanel={() => <div data-testid="guest" />} />
      </CanvasStoreProvider>,
    ))
    const overlay = container.querySelector<HTMLElement>('[data-unfocused-overlay]')!
    const content = overlay.parentElement!
    const node = container.querySelector<HTMLElement>('[data-node-id="A"]')!
    const rect = { left: 0, top: 0, right: 200, bottom: 150 } as DOMRect
    vi.spyOn(content, 'getBoundingClientRect').mockReturnValue(rect)
    vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(rect)
    const drag = (target: EventTarget, type: string, x = 50) => act(() => {
      const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: 50, relatedTarget: null })
      Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'] } })
      target.dispatchEvent(event)
    })

    expect(overlay.style.pointerEvents).toBe('auto')
    drag(overlay, 'dragenter')
    expect(overlay.style.pointerEvents).toBe('none')
    drag(overlay, 'dragleave') // Chromium hands the drag to the guest.
    expect(overlay.style.pointerEvents).toBe('none')
    drag(window, 'dragover', 250) // Guest events don't bubble; host sees the exit.
    expect(overlay.style.pointerEvents).toBe('auto')
    drag(overlay, 'dragenter')
    drag(overlay, 'dragleave')
    dispatchMouse(window, 'mousemove', { x: 50, y: 50 }) // After a guest drop.
    expect(overlay.style.pointerEvents).toBe('auto')
    drag(overlay, 'dragenter')
    drag(window, 'drop')
    expect(overlay.style.pointerEvents).toBe('auto')
  })
})

describe('CanvasNode — group drag from the title bar', () => {
  it('grabbing a multi-selected node by its tab bar arms a GROUP drag carrying the whole selection', () => {
    const wsId = useAppStore.getState().addWorkspace('WS', '/tmp/ws', 'ws-group-drag')
    useAppStore.getState().addPanel(wsId, { id: 'panel-A', type: 'editor', title: 'A', isDirty: false })

    const store = freshCanvasStore()
    addNode(store, 'A', 'panel-A', { x: 0, y: 0 }, { width: 200, height: 150 })
    addNode(store, 'B', 'panel-B', { x: 400, y: 0 }, { width: 200, height: 150 })

    // A real, un-activated multi-selection (rings, no halo) — the state in which
    // no node is focused and every node shows its dim overlay.
    act(() => store.getState().selectNodes(['A', 'B'], false))
    expect(store.getState().selectionActive).toBe(false)

    const dockA = tabsDockStore('panel-A')
    act(() => {
      root.render(
        <CanvasStoreProvider store={store}>
          <CanvasNode
            nodeId="A"
            isFocused={false}
            dockStoreApi={dockA}
            renderPanel={() => <div data-testid="content" />}
          />
        </CanvasStoreProvider>,
      )
    })

    const tabBar = container.querySelector<HTMLElement>('.dock-tab-bar')
    if (!tabBar) throw new Error('tab bar not rendered')

    // Press the title bar, then drag past the dead zone (4px) to arm the drag.
    dispatchMouse(tabBar, 'mousedown', { x: 50, y: 10 })
    dispatchMouse(window, 'mousemove', { x: 60, y: 10 }) // arm (past dead zone)

    // The armed drag's published source is a canvas-node carrying the OTHER
    // selected node as a member — i.e. a group drag, not a single-node move.
    const src = useDragStore.getState().source
    expect(src?.origin.kind).toBe('canvas-node')
    if (src?.origin.kind !== 'canvas-node') throw new Error('expected canvas-node source')
    expect(src.origin.nodeId).toBe('A')
    expect(src.origin.startOrigin).toEqual({ x: 0, y: 0 })
    expect(src.origin.members).toEqual([{ nodeId: 'B', startOrigin: { x: 400, y: 0 } }])

    // The capture-phase focus must NOT have collapsed the selection to [A].
    expect(store.getState().selection).toEqual(['A', 'B'])
    expect(store.getState().selectionActive).toBe(false)

    dispatchMouse(window, 'mouseup', { x: 60, y: 10 })
  })

  it.each(['A', 'B'])('respects locked node %s when dragging a selection', (lockedId) => {
    const wsId = useAppStore.getState().addWorkspace('WS', '/tmp/ws', 'ws-locked')
    useAppStore.getState().addPanel(wsId, { id: 'panel-A', type: 'editor', title: 'A', isDirty: false })
    const store = freshCanvasStore()
    addNode(store, 'A', 'panel-A', { x: 0, y: 0 }, { width: 200, height: 150 })
    addNode(store, 'B', 'panel-B', { x: 400, y: 0 }, { width: 200, height: 150 })
    act(() => {
      store.getState().togglePin(lockedId)
      store.getState().selectNodes(['A', 'B'], false)
      root.render(
        <CanvasStoreProvider store={store}>
          <CanvasNode nodeId="A" isFocused={false} dockStoreApi={tabsDockStore('panel-A')}
            renderPanel={() => <div />} />
        </CanvasStoreProvider>,
      )
    })
    const tabBar = container.querySelector<HTMLElement>('.dock-tab-bar')!
    dispatchMouse(tabBar, 'mousedown', { x: 50, y: 10 })
    dispatchMouse(window, 'mousemove', { x: 60, y: 10 })
    const source = useDragStore.getState().source
    if (lockedId === 'A') {
      expect(source).toBeNull()
    } else {
      expect(source?.origin.kind).toBe('canvas-node')
      if (source?.origin.kind !== 'canvas-node') throw new Error('expected canvas-node source')
      expect(source.origin.members).toEqual([])
    }
    dispatchMouse(window, 'mouseup', { x: 60, y: 10 })
    expect(store.getState().nodes[lockedId].origin).toEqual({ x: lockedId === 'A' ? 0 : 400, y: 0 })
  })

  it('clicking an already-focused node keeps it active (no blue-ring de-focus on the second click)', () => {
    const wsId = useAppStore.getState().addWorkspace('WS', '/tmp/ws', 'ws-refocus')
    useAppStore.getState().addPanel(wsId, { id: 'panel-A', type: 'editor', title: 'A', isDirty: false })

    const store = freshCanvasStore()
    addNode(store, 'A', 'panel-A', { x: 0, y: 0 }, { width: 200, height: 150 })

    // First click already happened: the node is the sole, activated selection
    // (halo, keyboard focus, panel content holds DOM focus).
    act(() => store.getState().focusNode('A'))
    expect(store.getState().selectionActive).toBe(true)

    const dockA = tabsDockStore('panel-A')
    act(() => {
      root.render(
        <CanvasStoreProvider store={store}>
          <CanvasNode
            nodeId="A"
            isFocused={true}
            dockStoreApi={dockA}
            renderPanel={() => <div data-testid="content" />}
          />
        </CanvasStoreProvider>,
      )
    })

    // A second click inside the focused panel's content bubbles to the node's
    // onClick. It must NOT deactivate the selection — otherwise focus is derived
    // away (selectionActive=false), the panel loses mouse focus and renders the
    // blue selection ring instead of the active halo.
    const content = container.querySelector<HTMLElement>('[data-testid="content"]')
    if (!content) throw new Error('panel content not rendered')
    dispatchMouse(content, 'click', { x: 50, y: 80 })

    expect(store.getState().selection).toEqual(['A'])
    expect(store.getState().selectionActive).toBe(true)
  })

  it('grabbing a single-selected node by its tab bar focuses it (no group takeover)', () => {
    const wsId = useAppStore.getState().addWorkspace('WS', '/tmp/ws', 'ws-single')
    useAppStore.getState().addPanel(wsId, { id: 'panel-A', type: 'editor', title: 'A', isDirty: false })

    const store = freshCanvasStore()
    addNode(store, 'A', 'panel-A', { x: 0, y: 0 }, { width: 200, height: 150 })
    addNode(store, 'B', 'panel-B', { x: 400, y: 0 }, { width: 200, height: 150 })

    // Only A selected: the capture-phase focus SHOULD run (no group drag).
    act(() => store.getState().selectNodes(['A'], false))

    const dockA = tabsDockStore('panel-A')
    act(() => {
      root.render(
        <CanvasStoreProvider store={store}>
          <CanvasNode
            nodeId="A"
            isFocused={false}
            dockStoreApi={dockA}
            renderPanel={() => <div data-testid="content" />}
          />
        </CanvasStoreProvider>,
      )
    })

    const tabBar = container.querySelector<HTMLElement>('.dock-tab-bar')
    if (!tabBar) throw new Error('tab bar not rendered')

    // A plain press (no drag) focuses this node via the capture handler.
    dispatchMouse(tabBar, 'mousedown', { x: 50, y: 10 })

    expect(store.getState().selection).toEqual(['A'])
    expect(store.getState().selectionActive).toBe(true)
    // B never moved.
    expect(store.getState().nodes['B'].origin).toEqual({ x: 400, y: 0 })
  })
})
