import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const registryMocks = vi.hoisted(() => ({
  getPanelDef: vi.fn(),
  renderPanelComponent: vi.fn(),
}))

vi.mock('./registry', () => registryMocks)
vi.mock('./PanelSuspense', () => ({
  PanelSuspense: ({ children }: { children: React.ReactNode }) => children,
}))

import { useAppStore } from '../stores/appStore'
import { PanelHost } from './PanelHost'
import type { PanelRenderContext } from './registry'
import type { PanelState } from '../../shared/types'

let host: HTMLDivElement
let root: Root

function panel(id: string, type: PanelState['type']): PanelState {
  return { id, type, title: id } as PanelState
}

beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState({ workspaces: ['ws', 'ws-1'].map((id) => ({ id, rootPath: '/project', panels: {} } as never)) })
  registryMocks.getPanelDef.mockReturnValue({ canLiveOnCanvas: true })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('PanelHost', () => {
  it('renders nothing for a missing panel record', () => {
    act(() => {
      root.render(<PanelHost panelId="missing" panels={{}} workspaceId="ws-1" />)
    })

    expect(host.innerHTML).toBe('')
    expect(registryMocks.renderPanelComponent).not.toHaveBeenCalled()
  })

  it('blocks a nested panel type that cannot live on a canvas', () => {
    registryMocks.getPanelDef.mockReturnValue({ canLiveOnCanvas: false })
    const panels = { nested: panel('nested', 'canvas') }

    act(() => {
      root.render(
        <PanelHost
          panelId="nested"
          panels={panels}
          workspaceId="ws-1"
          allowCanvas={false}
        />,
      )
    })

    expect(host.innerHTML).toBe('')
    expect(registryMocks.renderPanelComponent).not.toHaveBeenCalled()
  })

  it('routes workspace, node, and zoom context through a nested canvas render', () => {
    const panels = {
      canvas: panel('canvas', 'canvas'),
      child: panel('child', 'editor'),
    }
    registryMocks.renderPanelComponent.mockImplementation((record: PanelState, context: PanelRenderContext) => {
      if (record.id === 'canvas') {
        return <div>{context.renderPanelContent?.('child', 'child-node', 2)}</div>
      }
      return <span>Child editor</span>
    })

    act(() => {
      root.render(
        <PanelHost
          panelId="canvas"
          panels={panels}
          workspaceId="ws-1"
          nodeId="canvas-node"
          zoomLevel={0.75}
        />,
      )
    })

    expect(host.textContent).toBe('Child editor')
    expect(registryMocks.renderPanelComponent).toHaveBeenCalledTimes(2)
    expect(registryMocks.renderPanelComponent.mock.calls[0][1]).toMatchObject({
      workspaceId: 'ws-1',
      nodeId: 'canvas-node',
      zoomLevel: 0.75,
    })
    expect(registryMocks.renderPanelComponent.mock.calls[1][1]).toMatchObject({
      workspaceId: 'ws-1',
      nodeId: 'child-node',
      zoomLevel: 2,
    })
  })
})

it('updates only changed leaf content without invalidating the canvas render callback', () => {
  const panels = { canvas: panel('canvas', 'canvas'), a: panel('a', 'editor'), b: panel('b', 'editor') }
  registryMocks.renderPanelComponent.mockImplementation((record: PanelState, context: PanelRenderContext) => {
    if (record.type === 'canvas') return <>{context.renderPanelContent?.('a', 'na', 1)}{context.renderPanelContent?.('b', 'nb', 1)}</>
    return <span>{record.title}</span>
  })
  act(() => root.render(<PanelHost panelId="canvas" panels={panels} workspaceId="ws" />))
  registryMocks.renderPanelComponent.mockClear()
  act(() => root.render(<PanelHost panelId="canvas" panels={{ ...panels, a: { ...panels.a, title: 'Changed' } }} workspaceId="ws" />))
  expect(registryMocks.renderPanelComponent.mock.calls.map(([record]) => record.id)).toEqual(['a'])
  expect(host.textContent).toBe('Changedb')
})

it.each(['canvas', 'terminal', 'editor', 'browser', 'agent', 'review', 'surface'] as const)('gates %s content before mounting without a workspace', (type) => {
  const mounted = vi.fn()
  function Content() { React.useEffect(mounted, []); return <span>Content</span> }
  registryMocks.renderPanelComponent.mockReturnValue(<Content />)
  act(() => useAppStore.setState({ workspaces: [] }))
  act(() => root.render(<PanelHost panelId="p" panels={{ p: panel('p', type) }} workspaceId="missing" />))
  expect(host.textContent).toContain('No workspace selected')
  expect(mounted).not.toHaveBeenCalled()
})
