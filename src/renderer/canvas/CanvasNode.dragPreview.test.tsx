import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/terminal/terminalRegistry', () => ({
  terminalRegistry: {
    release: vi.fn(),
    dispose: vi.fn(),
    disposeWorkspace: vi.fn(),
    has: () => false,
    getEntry: () => undefined,
    ptyIdForPanel: () => undefined,
  },
}))

vi.mock('../stores/useWorktrees', () => ({ useWorktrees: () => [] }))

import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'
import type { PanelType, Point, Size, WindowDockState } from '../../shared/types'
import CanvasNode from './CanvasNode'
import DragOverlay from '../drag/Overlay'
import { useDragStore } from '../drag'
import { INITIAL_DRAG_STATE, type DragState } from '../drag/types'
import { CanvasStoreProvider } from '../stores/CanvasStoreContext'
import { createCanvasStore, type CanvasStore } from '../stores/canvasStore'
import { createDefaultDockState, createDockStore } from '../stores/dockStore'
import { useAppStore } from '../stores/appStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function addNode(
  store: StoreApi<CanvasStore>,
  id: string,
  panelId: string,
  panelType: PanelType,
  origin: Point,
  size: Size,
) {
  const created = store.getState().addNode(panelId, panelType, origin, size)
  store.setState((state) => {
    const node = state.nodes[created]
    if (!node) return state
    const nodes = { ...state.nodes }
    delete nodes[created]
    nodes[id] = { ...node, id, origin, size, animationState: 'idle' }
    return { nodes }
  })
}

function renderNode(panelType: 'terminal' | 'browser') {
  const panelId = `${panelType}-panel`
  const workspaceId = useAppStore.getState().addWorkspace('WS', '/tmp/ws', `ws-${panelType}`)
  useAppStore.getState().addPanel(workspaceId, {
    id: panelId,
    type: panelType,
    title: panelType,
    isDirty: false,
  })

  const canvasStore = createCanvasStore()
  canvasStore.getState().setZoomAndOffset(1, { x: 0, y: 0 })
  addNode(canvasStore, 'node', panelId, panelType, { x: 100, y: 100 }, { width: 300, height: 200 })
  const zones: WindowDockState = {
    ...createDefaultDockState(),
    center: {
      position: 'center',
      visible: true,
      size: 0,
      layout: { type: 'tabs', id: 'stack', panelIds: [panelId], activeIndex: 0 },
    },
  }
  const dockStore = createDockStore({ zones })

  act(() => root.render(
    <CanvasStoreProvider store={canvasStore}>
      <CanvasNode
        nodeId="node"
        isFocused
        dockStoreApi={dockStore}
        renderPanel={() => panelType === 'browser'
          ? React.createElement('webview', { 'data-panel-surface': panelType })
          : <div data-panel-surface={panelType}>terminal output</div>}
      />
      <DragOverlay />
    </CanvasStoreProvider>,
  ))

  return { canvasStore, panelId }
}

function startDrag(
  canvasStore: StoreApi<CanvasStore>,
  panelId: string,
  panelType: 'terminal' | 'browser',
  target: DragState['target'],
) {
  act(() => useDragStore.getState().applyDragState({
    ...INITIAL_DRAG_STATE,
    isDragging: true,
    source: {
      panelId,
      origin: { kind: 'canvas-node', canvasStoreApi: canvasStore, nodeId: 'node' },
    },
    panel: { id: panelId, type: panelType, title: panelType },
    grab: { x: 20, y: 10 },
    ghostSize: { width: 300, height: 200 },
    cursor: { client: { x: 200, y: 170 }, screen: { x: 200, y: 170 }, insideWindow: true },
    target,
  }))
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  useAppStore.setState({ workspaces: [], selectedWorkspaceId: '' })
  useDragStore.getState().applyDragState(INITIAL_DRAG_STATE)
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => { root = createRoot(container) })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useDragStore.getState().applyDragState(INITIAL_DRAG_STATE)
  vi.unstubAllGlobals()
})

describe('CanvasNode drag preview', () => {
  it.each(['terminal', 'browser'] as const)('hides the live %s surface and always renders the ghost', (panelType) => {
    const { canvasStore, panelId } = renderNode(panelType)
    startDrag(canvasStore, panelId, panelType, {
      kind: 'canvas-reposition',
      canvasStoreApi: canvasStore,
      nodeId: 'node',
      origin: { x: 180, y: 160 },
    })

    const node = container.querySelector<HTMLElement>('[data-node-id="node"]')!
    expect(node.style.left).toBe('100px')
    expect(node.style.top).toBe('100px')
    expect(node.style.visibility).toBe('hidden')
    expect(node.querySelector(`[data-panel-surface="${panelType}"]`)).not.toBeNull()
    expect(document.querySelector('[data-drag-overlay-ghost="true"]')).not.toBeNull()
  })
})
