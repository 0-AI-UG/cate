import React from 'react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'
import { CanvasStoreProvider } from '../stores/CanvasStoreContext'
import { createCanvasStore, type CanvasStore } from '../stores/canvasStore'
import { useAppStore } from '../stores/appStore'
import { beginPanelInteraction, clearPanelInteractions } from '../lib/panelInteractions'
import { PanelConnectionLayer } from './PanelConnectionLayer'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WS = 'ws-connections'
let container: HTMLDivElement
let root: Root
let initialAppState: ReturnType<typeof useAppStore.getState>

function canvasStore(): StoreApi<CanvasStore> {
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
      dockLayout: { type: 'tabs', id: 'target-tabs', panelIds: ['worker', 'browser'], activeIndex: 0 },
    },
  }, { x: 0, y: 0 }, 1)
  return store
}

beforeEach(() => {
  initialAppState = useAppStore.getState()
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
    const store = canvasStore()
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
})
