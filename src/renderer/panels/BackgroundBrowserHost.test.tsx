// @vitest-environment jsdom
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

let host: HTMLDivElement
let root: Root

Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: () => ({ x: 10, y: 20, left: 10, top: 20, right: 210, bottom: 120, width: 200, height: 100, toJSON: () => ({}) }),
})
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 200 })
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 100 })

function workspace(id: string): WorkspaceState {
  return {
    id, name: id, color: '', rootPath: `/tmp/${id}`,
    panels: {
      [`browser-${id}`]: {
        id: `browser-${id}`, type: 'browser', title: 'Browser', isDirty: false,
        tabs: [{ id: `tab-${id}`, url: `https://${id}.test/`, title: id }], activeTabId: `tab-${id}`,
      },
    },
  }
}

function SurfaceSlot(): React.ReactElement {
  const selected = useAppStore((state) => state.selectedWorkspaceId)
  return <BrowserPanelSurfaceSlot panelId={`browser-${selected}`} />
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useAppStore.setState({ workspaces: [workspace('one'), workspace('two')], selectedWorkspaceId: 'one' })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('BackgroundBrowserHost', () => {
  it('mounts every browser once and exposes only the surface with a visible slot', () => {
    act(() => root.render(
      <PersistentBrowserHostContext.Provider value>
        <SurfaceSlot />
        <BackgroundBrowserHost />
      </PersistentBrowserHostContext.Provider>,
    ))
    expect(host.querySelector('[data-browser-surface="browser-one"]')?.getAttribute('data-browser-surface-visible')).toBe('true')
    expect(host.querySelector('[data-browser-surface="browser-two"]')?.getAttribute('data-browser-surface-visible')).toBe('false')
  })

  it('parks rather than remounts a browser when the workspace changes', () => {
    act(() => root.render(
      <PersistentBrowserHostContext.Provider value>
        <SurfaceSlot />
        <BackgroundBrowserHost />
      </PersistentBrowserHostContext.Provider>,
    ))
    const original = host.querySelector('[data-browser-panel="browser-one"]')
    act(() => useAppStore.setState({ selectedWorkspaceId: 'two' }))
    act(() => useAppStore.setState({ selectedWorkspaceId: 'one' }))
    expect(host.querySelector('[data-browser-panel="browser-one"]')).toBe(original)
  })
})
