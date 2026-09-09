import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { createDockStore } from '../stores/dockStore'
import { DockStoreProvider, useDockStoreContext } from '../stores/DockStoreContext'
import DockSplitContainer from './DockSplitContainer'
import type { DockSplitNode } from '../../shared/types'

it('can drag away from the minimum and reverse direction during the same gesture', () => {
  const store = createDockStore()
  const split: DockSplitNode = {
    id: 'split', type: 'split', direction: 'horizontal', ratios: [0.4, 0.6],
    children: ['a', 'b'].map((id) => ({ id, type: 'tabs', panelIds: [id], activeIndex: 0 })),
  }
  store.setState((state) => ({ zones: { ...state.zones, center: { ...state.zones.center, layout: split } } }))
  function Harness() {
    const node = useDockStoreContext((state) => state.zones.center.layout) as DockSplitNode
    return <DockSplitContainer node={node} getPanelType={() => 'editor'} renderNode={() => null} />
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    act(() => root.render(<DockStoreProvider store={store}><Harness /></DockStoreProvider>))
    Object.defineProperty(host.firstElementChild!, 'offsetWidth', { value: 1000 })
    const handle = host.querySelector('.cursor-col-resize')!
    act(() => handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 400 })))
    act(() => document.dispatchEvent(new MouseEvent('mousemove', { clientX: 500 })))
    expect((store.getState().zones.center.layout as DockSplitNode).ratios[0]).toBeCloseTo(0.4 + 100 / 995)
    act(() => document.dispatchEvent(new MouseEvent('mousemove', { clientX: 450 })))
    expect((store.getState().zones.center.layout as DockSplitNode).ratios[0]).toBeCloseTo(0.4 + 50 / 995)
  } finally {
    act(() => document.dispatchEvent(new MouseEvent('mouseup')))
    act(() => root.unmount())
    host.remove()
  }
})
