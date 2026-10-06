// A container's tab headers use the same compact mini heading as canvas windows.

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../lib/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../lib/terminal/terminalRegistry', () => ({
  terminalRegistry: { entries: () => [], panelIdForPty: () => null, ptyIdForPanel: () => null, has: () => false, getEntry: () => undefined, dispose: vi.fn(), release: vi.fn(), disposeWorkspace: vi.fn() },
}))
vi.mock('./PanelHost', () => ({ PanelHost: ({ panelId }: { panelId: string }) => <div data-testid={`body-${panelId}`} /> }))

import ContainerPanel from './ContainerPanel'
import { useAppStore } from '../stores/appStore'

const WS = 'ws-container'
const layout = {
  type: 'split', id: 'sp', direction: 'horizontal', ratios: [0.5, 0.5], children: [
    { type: 'tabs', id: 'a', panelIds: ['p1', 'p2'], activeIndex: 0 },
    { type: 'tabs', id: 'b', panelIds: ['p3'], activeIndex: 0 },
  ],
}
const panel = (id: string, type: string, extra = {}) => ({ id, type, title: id, isDirty: false, ...extra })

let root: Root | null = null
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; useAppStore.setState({ workspaces: [], selectedWorkspaceId: null } as never) })

describe('ContainerPanel', () => {
  it('renders every pane header in compact (canvas-window) mode', () => {
    ;(window as never as { electronAPI: object }).electronAPI = { onFsWatchEvent: () => () => {}, fsWatchStart: async () => {}, fsWatchStop: async () => {} }
    ;(globalThis as never as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
    useAppStore.setState({
      selectedWorkspaceId: WS,
      workspaces: [{ id: WS, name: 'ws', color: '', rootPath: '/ws', panels: Object.fromEntries([
        panel('ct', 'container', { containerLayout: layout }), panel('p1', 'terminal'), panel('p2', 'editor'), panel('p3', 'terminal'),
      ].map((p) => [p.id, p])) }] as never,
    })
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root!.render(<ContainerPanel panelId="ct" workspaceId={WS} />))

    const bars = host.querySelectorAll('.dock-tab-bar')
    expect(bars).toHaveLength(2) // one header per split pane
    for (const bar of bars) {
      expect(bar.className).toContain('min-h-[26px]') // compact strip
      expect(bar.className).not.toContain('app-header-bar') // not the full-size band
    }
  })
})
