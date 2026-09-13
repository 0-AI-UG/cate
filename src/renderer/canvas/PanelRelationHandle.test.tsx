// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PanelRelationHandle } from './PanelRelationHandle'
import { useAppStore } from '../stores/appStore'
import { useUIStore } from '../stores/uiStore'
import { CanvasStoreProvider } from '../stores/CanvasStoreContext'
import { getOrCreateCanvasStoreForPanel, releaseCanvasStoreForPanel } from '../stores/canvasStore'
import { CanvasRelationOverlayContext } from './CanvasTopOverlayContext'
import { panelConnectionAnchor } from './panelConnectionGeometry'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let initialAppState: ReturnType<typeof useAppStore.getState>

beforeEach(() => {
  initialAppState = useAppStore.getState()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.querySelector('[data-test-target]')?.remove()
  releaseCanvasStoreForPanel('canvas')
  useAppStore.setState(initialAppState, true)
  useUIStore.getState().openPanelRelationEditor(null)
  vi.restoreAllMocks()
})

describe('PanelRelationHandle', () => {
  it('renders one outside connection point on every side', () => {
    act(() => root.render(<PanelRelationHandle workspaceId="ws" sourcePanelId="source" />))

    const handles = [...container.querySelectorAll('[data-panel-connection-handle]')]
    expect(handles.map((handle) => handle.getAttribute('data-panel-connection-handle'))).toEqual([
      'top', 'right', 'bottom', 'left',
    ])
    expect(handles.every((handle) => handle.classList.contains('h-5') && handle.classList.contains('w-5'))).toBe(true)
    expect(handles.every((handle) => handle.querySelector('.h-2.w-2.bg-focus-blue'))).toBe(true)
  })

  it('snaps to a browser port without relying on webview pointer events', async () => {
    useAppStore.setState({
      workspaces: [{
        id: 'ws',
        panels: {
          source: { id: 'source', type: 'terminal', title: 'Terminal' },
          browser: { id: 'browser', type: 'browser', title: 'Browser' },
        },
      }],
    } as never)
    const showContextMenu = vi.fn(async () => null)
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { showContextMenu },
    })
    const target = document.createElement('div')
    target.dataset.testTarget = 'true'
    target.dataset.nodeId = 'browser-node'
    target.dataset.activePanelId = 'browser'
    target.getBoundingClientRect = () => ({
      left: 300, right: 700, top: 100, bottom: 500, width: 400, height: 400,
      x: 300, y: 100, toJSON: () => ({}),
    })
    document.body.appendChild(target)

    act(() => root.render(<PanelRelationHandle workspaceId="ws" sourcePanelId="source" />))
    const source = container.querySelector<HTMLElement>('[data-panel-connection-handle="right"]')!
    source.getBoundingClientRect = () => ({
      left: 180, right: 196, top: 292, bottom: 308, width: 16, height: 16,
      x: 180, y: 292, toJSON: () => ({}),
    })
    act(() => source.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 188, clientY: 300 })))
    const overlay = document.body.querySelector<HTMLElement>('.cursor-crosshair')!
    act(() => overlay.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 288, clientY: 300 })))
    expect(document.body.querySelectorAll('[data-panel-connection-target]')).toHaveLength(4)
    await act(async () => {
      overlay.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 288, clientY: 300 }))
    })

    expect(useAppStore.getState().workspaces[0].panelRelations).toEqual([
      expect.objectContaining({
        fromPanelId: 'source', toPanelId: 'browser', kind: 'use', fromSide: 'right', toSide: 'left',
      }),
    ])
    expect(showContextMenu).not.toHaveBeenCalled()
    expect(useUIStore.getState().editingPanelRelationId).toBe(
      useAppStore.getState().workspaces[0].panelRelations?.[0].id,
    )
  })

  it('opens the panel picker in the relation portal and links the created panel', async () => {
    useAppStore.setState({
      selectedWorkspaceId: 'ws',
      workspaces: [{
        id: 'ws',
        panels: {
          canvas: { id: 'canvas', type: 'canvas', title: 'Canvas' },
          source: { id: 'source', type: 'terminal', title: 'Terminal' },
        },
      }],
    } as never)
    const store = getOrCreateCanvasStoreForPanel('canvas')
    const sourceNodeId = store.getState().addNode('source', 'terminal', { x: 0, y: 0 }, { width: 100, height: 100 })
    store.setState({
      zoomLevel: 2,
      viewportOffset: { x: 20, y: 40 },
      containerSize: { width: 800, height: 600 },
    })
    const canvas = document.createElement('div')
    canvas.dataset.canvasContainer = ''
    canvas.dataset.canvasPanelId = 'canvas'
    canvas.getBoundingClientRect = () => ({
      left: 100, right: 1300, top: 50, bottom: 650, width: 1200, height: 600,
      x: 100, y: 50, toJSON: () => ({}),
    })
    const relationPortal = document.createElement('div')
    Object.defineProperty(relationPortal, 'offsetWidth', { configurable: true, value: 1 })
    canvas.appendChild(container)
    document.body.append(canvas, relationPortal)

    act(() => root.render(
      <CanvasStoreProvider store={store}>
        <CanvasRelationOverlayContext.Provider value={relationPortal}>
          <PanelRelationHandle workspaceId="ws" sourcePanelId="source" />
        </CanvasRelationOverlayContext.Provider>
      </CanvasStoreProvider>,
    ))
    const source = container.querySelector<HTMLElement>('[data-panel-connection-handle="right"]')!
    source.getBoundingClientRect = () => ({
      left: 180, right: 196, top: 292, bottom: 308, width: 16, height: 16,
      x: 180, y: 292, toJSON: () => ({}),
    })
    act(() => source.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })))
    const overlay = document.body.querySelector<HTMLElement>('.cursor-crosshair')!
    await act(async () => {
      overlay.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 1000, clientY: 350 }))
    })

    expect(container.querySelector('[aria-label="New linked panel"]')).toBeNull()
    const menu = relationPortal.querySelector<HTMLElement>('[aria-label="New linked panel"]')!
    expect(menu).not.toBeNull()
    expect(menu.querySelector('[data-panel-connection-menu-port]')).not.toBeNull()
    const preview = relationPortal.querySelector<SVGPathElement>('[data-panel-connection-create-preview] path')!
    expect(preview.getAttribute('d')).toMatch(/^M 34 105 C /)
    expect(preview.getAttribute('d')).toMatch(/, 440 130$/)
    expect(preview.getAttribute('stroke-dasharray')).toBe('6 5')
    expect(menu.style.top).toBe('130px')
    expect(menu.style.right).toBe('-671px')
    expect(menu.style.transform).toBe('translateY(-50%)')
    expect(menu.style.animation).toBe('none')
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).not.toContain('Canvas')

    await act(async () => {
      ;[...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((item) => item.textContent === 'Browser')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const workspace = useAppStore.getState().workspaces[0]
    const browser = Object.values(workspace.panels).find((panel) => panel.type === 'browser')!
    expect(workspace.panelRelations).toEqual([
      expect.objectContaining({
        fromPanelId: 'source', toPanelId: browser.id, kind: 'use', fromSide: 'right', toSide: 'left',
      }),
    ])
    const browserNodeId = store.getState().nodeForPanel(browser.id)!
    const browserNode = store.getState().nodes[browserNodeId]!
    expect(browserNode.origin).toEqual({ x: 452, y: -170 })
    expect(workspace.panelRelations?.[0].toSide).toBe('left')
    expect(panelConnectionAnchor(
      { origin: browserNode.origin, size: browserNode.size },
      workspace.panelRelations![0].toSide!,
    )).toEqual({ x: 440, y: 130 })
    expect(store.getState().selection).toEqual([browserNodeId])
    for (const nodeId of [sourceNodeId, browserNodeId]) {
      const frame = store.getState().viewFrame(nodeId)!
      expect(frame.origin.x).toBeGreaterThanOrEqual(0)
      expect(frame.origin.y).toBeGreaterThanOrEqual(0)
      expect(frame.origin.x + frame.size.width).toBeLessThanOrEqual(800)
      expect(frame.origin.y + frame.size.height).toBeLessThanOrEqual(600)
    }

    relationPortal.remove()
    canvas.remove()
  })
})
