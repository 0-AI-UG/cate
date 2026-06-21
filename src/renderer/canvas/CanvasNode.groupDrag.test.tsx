// =============================================================================
// CanvasNode group-drag regression — pins the fix for "grabbing a selected
// panel's title bar moves only that one panel".
//
// A multi-selection is never "activated", so no node is focused and every node
// renders its dim overlay. Pressing a node in that state must start a GROUP
// move (translate the whole selection). The hazard this test guards against:
// the dock-content wrapper has a CAPTURE-phase mousedown handler that focuses
// the node, and capture runs BEFORE the bubble-phase tab-bar handler that
// kicks off the group drag. If that capture handler focuses unconditionally it
// collapses the selection to the grabbed node (focusNode → selection=[id])
// before useGroupNodeDrag reads it — so the group drag sees a single-node
// selection, bails, and only the grabbed panel moves.
//
// Driven through the REAL CanvasNode (not a probe): a real mousedown on the
// rendered `.dock-tab-bar`, then real window mousemoves. The only faked surface
// is terminalRegistry (its import-time side effects explode under jsdom); the
// electronAPI stub comes from the shared setup file.
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
  return createDockStore({ zones, locations: {} })
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

describe('CanvasNode — group drag from the title bar', () => {
  it('grabbing a multi-selected node by its tab bar moves the WHOLE selection, not just the grabbed one', () => {
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

    // Press the title bar, then drag past the dead zone (4px) and on to a delta.
    dispatchMouse(tabBar, 'mousedown', { x: 50, y: 10 })
    dispatchMouse(window, 'mousemove', { x: 60, y: 10 }) // arm (past dead zone)
    dispatchMouse(window, 'mousemove', { x: 90, y: 40 }) // → delta (+40, +30)

    // BOTH nodes translated by the same delta — the whole selection moved.
    expect(store.getState().nodes['A'].origin).toEqual({ x: 40, y: 30 })
    expect(store.getState().nodes['B'].origin).toEqual({ x: 440, y: 30 })
    // The capture-phase focus must NOT have collapsed the selection to [A].
    expect(store.getState().selection).toEqual(['A', 'B'])
    expect(store.getState().selectionActive).toBe(false)

    dispatchMouse(window, 'mouseup', { x: 90, y: 40 })
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
