import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceState } from '../../shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./BrowserPanel', () => ({
  default: ({ panelId, workspaceId }: { panelId: string; workspaceId: string }) => (
    <div data-browser-panel={panelId} data-workspace={workspaceId} />
  ),
}))

import BackgroundBrowserHost from './BackgroundBrowserHost'
import { BrowserPanelSurfaceSlot, PersistentBrowserHostContext } from './browserSurfaceRegistry'
import { useAppStore } from '../stores/appStore'

const initialState = useAppStore.getState()
let container: HTMLDivElement
let root: Root

Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: () => ({ x: 10, y: 20, left: 10, top: 20, right: 210, bottom: 120, width: 200, height: 100, toJSON: () => ({}) }),
})
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get: () => 200,
})
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get: () => 100,
})

function VisibleBrowserSlot(): React.ReactElement {
  const selectedWorkspaceId = useAppStore((state) => state.selectedWorkspaceId)
  return <BrowserPanelSurfaceSlot panelId={`browser-${selectedWorkspaceId}`} />
}

function renderHost(): void {
  act(() => root.render(
    <PersistentBrowserHostContext.Provider value>
      <VisibleBrowserSlot />
      <BackgroundBrowserHost />
    </PersistentBrowserHostContext.Provider>,
  ))
}

function workspace(id: string): WorkspaceState {
  return {
    id,
    name: id,
    color: '',
    rootPath: `/tmp/${id}`,
    panels: {
      [`browser-${id}`]: {
        id: `browser-${id}`,
        type: 'browser',
        title: 'Browser',
        isDirty: false,
        tabs: [{ id: `tab-${id}`, url: `https://${id}.example`, title: id }],
        activeTabId: `tab-${id}`,
      },
      [`terminal-${id}`]: {
        id: `terminal-${id}`,
        type: 'terminal',
        title: 'Terminal',
        isDirty: false,
      },
    },
  }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useAppStore.setState({
    workspaces: [workspace('one'), workspace('two')],
    selectedWorkspaceId: 'one',
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useAppStore.setState(initialState, true)
})

describe('BackgroundBrowserHost', () => {
  it('mounts every browser once and aligns only the selected surface to its slot', () => {
    renderHost()

    expect(container.querySelector('[data-browser-surface="browser-one"]')
      ?.getAttribute('data-browser-surface-visible')).toBe('true')
    expect(container.querySelector('[data-browser-surface="browser-two"]')
      ?.getAttribute('data-browser-surface-visible')).toBe('false')
    expect(container.querySelector('[data-browser-panel="terminal-two"]')).toBeNull()
  })

  it('preserves the same browser component while switching away and back', () => {
    renderHost()
    const original = container.querySelector('[data-browser-panel="browser-one"]')

    act(() => useAppStore.setState({ selectedWorkspaceId: 'two' }))
    expect(container.querySelector('[data-browser-surface="browser-one"]')
      ?.getAttribute('data-browser-surface-visible')).toBe('false')
    expect(container.querySelector('[data-browser-surface="browser-two"]')
      ?.getAttribute('data-browser-surface-visible')).toBe('true')

    act(() => useAppStore.setState({ selectedWorkspaceId: 'one' }))

    expect(container.querySelector('[data-browser-panel="browser-one"]')).toBe(original)
    expect(container.querySelector('[data-browser-surface="browser-one"]')
      ?.getAttribute('data-browser-surface-visible')).toBe('true')
  })
})
