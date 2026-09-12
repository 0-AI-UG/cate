import React from 'react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'
import { CanvasStoreProvider } from '../stores/CanvasStoreContext'
import { createCanvasStore, type CanvasStore } from '../stores/canvasStore'
import { useAppStore } from '../stores/appStore'
import { useSettingsStore } from '../stores/settingsStore'
import { beginPanelInteraction, clearPanelInteractions } from '../lib/panelInteractions'
import { PanelConnectionLayer } from './PanelConnectionLayer'
import { CanvasRelationOverlayContext } from './CanvasTopOverlayContext'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WS = 'ws-connections'
let container: HTMLDivElement
let root: Root
let initialAppState: ReturnType<typeof useAppStore.getState>
let initialSettingsState: ReturnType<typeof useSettingsStore.getState>
let initialElectronAPI: typeof window.electronAPI

function canvasStore(targetActiveIndex = 0): StoreApi<CanvasStore> {
  const store = createCanvasStore()
  store.getState().loadWorkspaceCanvas({
    source: {
      id: 'source',
      origin: { x: 0, y: 0 },
      size: { width: 200, height: 120 },
      zOrder: 0,
      creationIndex: 0,
      animationState: 'idle',
      dockLayout: { type: 'tabs', id: 'source-tabs', panelIds: ['agent'], activeIndex: 0 },
    },
    target: {
      id: 'target',
      origin: { x: 400, y: 0 },
      size: { width: 200, height: 120 },
      zOrder: 1,
      creationIndex: 1,
      animationState: 'idle',
      dockLayout: { type: 'tabs', id: 'target-tabs', panelIds: ['worker', 'browser'], activeIndex: targetActiveIndex },
    },
  }, { x: 0, y: 0 }, 1)
  return store
}

beforeEach(() => {
  initialAppState = useAppStore.getState()
  initialSettingsState = useSettingsStore.getState()
  initialElectronAPI = window.electronAPI
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { ...initialElectronAPI, settingsSet: vi.fn(async () => {}) },
  })
  useSettingsStore.setState({ savedPanelRelationLabels: [], panelRelationsEnabled: true })
  clearPanelInteractions()
  useAppStore.setState({
    selectedWorkspaceId: WS,
    workspaces: [{
      id: WS,
      panels: {
        agent: { id: 'agent', type: 'agent', title: 'Agent' },
        worker: {
          id: 'worker',
          type: 'terminal',
          title: 'Worker',
          codingAgentRun: {
            id: 'run-1',
            agentId: 'codex',
            panelId: 'worker',
            ownerPanelId: 'agent',
            prompt: 'private prompt',
            createdAt: 1,
          },
        },
        browser: { id: 'browser', type: 'browser', title: 'Browser' },
      },
    }],
  } as never)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  clearPanelInteractions()
  useAppStore.setState(initialAppState, true)
  useSettingsStore.setState(initialSettingsState, true)
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: initialElectronAPI })
})

describe('PanelConnectionLayer', () => {
  it('renders durable supervisor-to-worker ownership as a directed path', () => {
    const store = canvasStore()
    act(() => {
      root.render(
        <CanvasStoreProvider store={store}>
          <PanelConnectionLayer workspaceId={WS} />
        </CanvasStoreProvider>,
      )
    })

    const path = container.querySelector('[data-panel-connection="persistent"]')
    expect(path).not.toBeNull()
    expect(path?.getAttribute('marker-end')).toContain('persistent')
  })

  it('overlays resolved CLI activity and never renders request contents', () => {
    const store = canvasStore(1)
    act(() => {
      root.render(
        <CanvasStoreProvider store={store}>
          <PanelConnectionLayer workspaceId={WS} />
        </CanvasStoreProvider>,
      )
    })
    act(() => {
      beginPanelInteraction({
        workspaceId: WS,
        sourcePanelId: 'agent',
        targetPanelId: 'browser',
        kind: 'control',
      })
    })

    expect(container.querySelector('[data-panel-connection="active"]')).not.toBeNull()
    expect(container.textContent).not.toContain('private prompt')
  })

  it('renders a user-declared relation with a horizontal meaning selector', () => {
    useAppStore.getState().addPanelRelation(WS, 'agent', 'browser', 'use')
    const store = canvasStore(1)
    act(() => {
      root.render(
        <CanvasStoreProvider store={store}>
          <PanelConnectionLayer workspaceId={WS} />
        </CanvasStoreProvider>,
      )
    })

    expect(container.querySelector('[data-panel-connection="relation"]')).not.toBeNull()
    expect(container.querySelector('[data-panel-connection="relation"]')?.classList.contains('cate-panel-connection')).toBe(true)
    expect(container.querySelector('[data-panel-connection="relation"]')?.classList.contains('cate-panel-connection-active')).toBe(false)
    const selector = container.querySelector('[data-panel-relation-selector]')
    expect(selector).not.toBeNull()
    expect(selector?.classList.contains('z-[100001]')).toBe(true)
    expect(container.querySelector('textPath')).toBeNull()
    expect(container.textContent).toContain('Work in')
  })

  it('hides user relations while preserving agent activity connections when disabled', () => {
    useAppStore.getState().addPanelRelation(WS, 'agent', 'worker', 'trigger')
    useSettingsStore.setState({ panelRelationsEnabled: false })
    const store = canvasStore()
    act(() => {
      root.render(
        <CanvasStoreProvider store={store}>
          <PanelConnectionLayer workspaceId={WS} />
        </CanvasStoreProvider>,
      )
    })

    expect(container.querySelector('[data-panel-connection="relation"]')).toBeNull()
    expect(container.querySelector('[data-panel-relation-selector]')).toBeNull()
    expect(container.querySelector('[data-panel-connection="persistent"]')).not.toBeNull()
  })

  it('starts a different-colored flow at every terminal or T3 panel', () => {
    useAppStore.setState({
      selectedWorkspaceId: WS,
      workspaces: [{
        id: WS,
        panels: {
          a: { id: 'a', type: 'terminal', title: 'A' },
          b: { id: 'b', type: 'browser', title: 'B' },
          c: { id: 'c', type: 'agent', title: 'C' },
          d: { id: 'd', type: 'terminal', title: 'D' },
          e: { id: 'e', type: 'editor', title: 'E' },
        },
        panelRelations: [
          { id: 'flow-one-a', fromPanelId: 'a', toPanelId: 'b', kind: 'use' },
          { id: 'flow-one-b', fromPanelId: 'b', toPanelId: 'c', kind: 'context' },
          { id: 'flow-two-a', fromPanelId: 'c', toPanelId: 'e', kind: 'context' },
          { id: 'flow-three', fromPanelId: 'd', toPanelId: 'b', kind: 'use' },
        ],
      }],
    } as never)
    const store = createCanvasStore()
    store.getState().loadWorkspaceCanvas(Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((panelId, index) => [panelId, {
      id: panelId,
      origin: { x: index * 240, y: index < 3 ? 0 : 240 },
      size: { width: 180, height: 100 },
      zOrder: index,
      creationIndex: index,
      animationState: 'idle',
      dockLayout: { type: 'tabs', id: `${panelId}-tabs`, panelIds: [panelId], activeIndex: 0 },
    }])), { x: 0, y: 0 }, 1)

    act(() => {
      root.render(
        <CanvasStoreProvider store={store}>
          <PanelConnectionLayer workspaceId={WS} />
        </CanvasStoreProvider>,
      )
    })

    const first = container.querySelector('[data-panel-relation-id="flow-one-a"]')!
    const handoff = container.querySelector('[data-panel-relation-id="flow-one-b"]')!
    const receiverFlow = container.querySelector('[data-panel-relation-id="flow-two-a"]')!
    const otherSenderFlow = container.querySelector('[data-panel-relation-id="flow-three"]')!
    expect(first.getAttribute('stroke')).toBe(handoff.getAttribute('stroke'))
    expect(first.getAttribute('marker-end')).toBe(handoff.getAttribute('marker-end'))
    expect(receiverFlow.getAttribute('stroke')).not.toBe(first.getAttribute('stroke'))
    expect(receiverFlow.getAttribute('marker-end')).not.toBe(first.getAttribute('marker-end'))
    expect(otherSenderFlow.getAttribute('stroke')).not.toBe(first.getAttribute('stroke'))
    expect(otherSenderFlow.getAttribute('stroke')).not.toBe(receiverFlow.getAttribute('stroke'))
  })

  it('portals only the relation menu above persistent browser surfaces', () => {
    useAppStore.getState().addPanelRelation(WS, 'agent', 'browser', 'use')
    const store = canvasStore(1)
    const overlay = document.createElement('div')
    document.body.appendChild(overlay)
    act(() => {
      root.render(
        <CanvasStoreProvider store={store}>
          <CanvasRelationOverlayContext.Provider value={overlay}>
            <PanelConnectionLayer workspaceId={WS} />
          </CanvasRelationOverlayContext.Provider>
        </CanvasStoreProvider>,
      )
    })

    expect(container.querySelector('[data-panel-connection="relation"]')).not.toBeNull()
    expect(container.querySelector('[data-panel-relation-selector]')).not.toBeNull()
    expect(container.querySelector('[data-panel-relation-chip]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Connection meaning"]')).toBeNull()
    expect(overlay.querySelector('[aria-label="Connection meaning"]')).not.toBeNull()
    expect(overlay.querySelector('[data-panel-relation-chip]')).toBeNull()

    act(() => root.render(<div />))
    overlay.remove()
  })

  it('drags the relationship chip as a zoom-aware point on the curve', () => {
    useAppStore.getState().addPanelRelation(WS, 'agent', 'browser', 'use')
    const store = canvasStore(1)
    store.setState({ zoomLevel: 2 })
    act(() => {
      root.render(
        <CanvasStoreProvider store={store}>
          <PanelConnectionLayer workspaceId={WS} />
        </CanvasStoreProvider>,
      )
    })

    const chip = container.querySelector<HTMLElement>('[data-panel-relation-chip]')!
    act(() => chip.dispatchEvent(new MouseEvent('pointerdown', {
      bubbles: true, button: 0, clientX: 600, clientY: 120,
    })))
    act(() => window.dispatchEvent(new MouseEvent('pointermove', {
      bubbles: true, clientX: 640, clientY: 140,
    })))
    act(() => window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })))

    const relation = useAppStore.getState().workspaces
      .find((workspace) => workspace.id === WS)!.panelRelations![0]
    expect(relation.waypoint).toEqual({ x: 320, y: 70 })
    expect(container.querySelector<HTMLElement>('[data-panel-relation-selector]')!.style.left).toBe('320px')
  })

  it('removes a connection from the persistent selector', () => {
    useAppStore.getState().addPanelRelation(WS, 'agent', 'browser', 'use')
    const relationId = useAppStore.getState().workspaces
      .find((workspace) => workspace.id === WS)!.panelRelations![0].id
    const store = canvasStore(1)
    act(() => {
      root.render(
        <CanvasStoreProvider store={store}>
          <PanelConnectionLayer workspaceId={WS} />
        </CanvasStoreProvider>,
      )
    })

    const remove = container.querySelector(`[data-panel-connection-delete="${relationId}"]`)
    expect(remove).not.toBeNull()

    act(() => remove!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(useAppStore.getState().workspaces
      .find((workspace) => workspace.id === WS)!.panelRelations).toEqual([])
  })

  it('adds a custom relationship from the menu', () => {
    useAppStore.getState().addPanelRelation(WS, 'agent', 'browser', 'use')
    const store = canvasStore(1)
    act(() => {
      root.render(
        <CanvasStoreProvider store={store}>
          <PanelConnectionLayer workspaceId={WS} />
        </CanvasStoreProvider>,
      )
    })

    act(() => container.querySelector<HTMLElement>('[data-panel-relation-trigger]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const add = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent?.includes('Add custom relationship'))!
    act(() => add.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const input = container.querySelector<HTMLInputElement>('[data-panel-relation-custom-input]')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'summarizes for')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))

    expect(container.querySelector('[data-panel-connection="relation"]')).not.toBeNull()
    expect(container.textContent).toContain('summarizes for')
    expect(useSettingsStore.getState().savedPanelRelationLabels).toEqual(['summarizes for'])
  })

  it('edits, reuses, and deletes saved relationship labels inline', () => {
    useSettingsStore.setState({ savedPanelRelationLabels: ['summarizes for', 'checks with'] })
    useAppStore.getState().addPanelRelation(WS, 'agent', 'browser', 'use')
    const store = canvasStore(1)
    const canvasMouseDown = vi.fn()
    act(() => {
      root.render(
        <div onMouseDown={canvasMouseDown}>
          <CanvasStoreProvider store={store}>
            <PanelConnectionLayer workspaceId={WS} />
          </CanvasStoreProvider>
        </div>,
      )
    })

    act(() => container.querySelector<HTMLElement>('[data-panel-relation-trigger]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.textContent).toContain('Saved relationships')
    const edit = container.querySelector<HTMLButtonElement>('[aria-label="Edit saved relationship summarizes for"]')!
    expect(edit.nextElementSibling?.getAttribute('aria-label')).toBe('Delete saved relationship summarizes for')
    act(() => edit.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const input = container.querySelector<HTMLInputElement>('[aria-label="Edit saved relationship summarizes for"]')!
    act(() => input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10 })))
    expect(canvasMouseDown).not.toHaveBeenCalled()
    expect(input.classList.contains('select-text')).toBe(true)
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'reports to')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(useSettingsStore.getState().savedPanelRelationLabels).toEqual(['reports to', 'checks with'])

    const reuse = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .find((button) => button.textContent?.includes('reports to'))!
    act(() => reuse.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.textContent).toContain('reports to')

    act(() => container.querySelector<HTMLElement>('[data-panel-relation-trigger]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const remove = container.querySelector<HTMLButtonElement>('[aria-label="Delete saved relationship reports to"]')!
    act(() => remove.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(useSettingsStore.getState().savedPanelRelationLabels).toEqual(['checks with'])
    expect(useAppStore.getState().workspaces[0].panelRelations?.[0].label).toBe('reports to')
    expect(container.textContent).toContain('reports to')
  })

  it('renders relations only while both addressed panels are visible', () => {
    useAppStore.getState().addPanelRelation(WS, 'agent', 'browser', 'use')
    const store = canvasStore()
    act(() => {
      root.render(
        <CanvasStoreProvider store={store}>
          <PanelConnectionLayer workspaceId={WS} />
        </CanvasStoreProvider>,
      )
    })

    expect(container.querySelector('[data-panel-connection="relation"]')).toBeNull()
    expect(container.querySelector('[data-panel-relation-selector]')).toBeNull()

    act(() => store.getState().setNodeDockLayout('target', {
      type: 'tabs', id: 'target-tabs', panelIds: ['worker', 'browser'], activeIndex: 1,
    }))

    expect(container.querySelector('[data-panel-connection="relation"]')).not.toBeNull()
    expect(container.querySelector('[data-panel-relation-selector]')).not.toBeNull()
  })

  it('animates the existing dashed relation path while that panel pair is active', () => {
    useAppStore.getState().addPanelRelation(WS, 'agent', 'browser', 'use')
    const store = canvasStore(1)
    act(() => {
      root.render(
        <CanvasStoreProvider store={store}>
          <PanelConnectionLayer workspaceId={WS} />
        </CanvasStoreProvider>,
      )
    })
    const idlePath = container.querySelector('[data-panel-connection="relation"]')

    act(() => {
      beginPanelInteraction({
        workspaceId: WS,
        sourcePanelId: 'agent',
        targetPanelId: 'browser',
        kind: 'control',
      })
    })

    const activePath = container.querySelector('[data-panel-connection="active"]')
    expect(activePath).toBe(idlePath)
    expect(activePath?.classList.contains('cate-panel-connection-active')).toBe(true)
    expect(container.querySelectorAll('path[data-panel-connection]')).toHaveLength(1)
  })
})
