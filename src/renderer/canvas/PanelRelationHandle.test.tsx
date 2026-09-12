// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PanelRelationHandle } from './PanelRelationHandle'
import { useAppStore } from '../stores/appStore'
import { useUIStore } from '../stores/uiStore'

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
  useAppStore.setState(initialAppState, true)
  useUIStore.getState().openPanelRelationEditor(null)
})

describe('PanelRelationHandle', () => {
  it('renders one outside connection point on every side', () => {
    act(() => root.render(<PanelRelationHandle workspaceId="ws" sourcePanelId="source" />))

    const handles = [...container.querySelectorAll('[data-panel-connection-handle]')]
    expect(handles.map((handle) => handle.getAttribute('data-panel-connection-handle'))).toEqual([
      'top', 'right', 'bottom', 'left',
    ])
    expect(handles.every((handle) => handle.classList.contains('h-5') && handle.classList.contains('w-5'))).toBe(true)
    expect(handles.every((handle) => handle.querySelector('.h-2.w-2'))).toBe(true)
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
})
