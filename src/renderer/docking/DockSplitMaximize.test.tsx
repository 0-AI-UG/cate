import React, { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { createDockStore } from '../stores/dockStore'
import { DockStoreProvider } from '../stores/DockStoreContext'
import DockLayoutRenderer from './DockLayoutRenderer'
import type { DockLayoutNode } from '../../shared/types'

it('maximizes nested panes without remounting or changing ratios and restores the layout', () => {
  const tabs = (id: string): DockLayoutNode => ({ id, type: 'tabs', panelIds: [id], activeIndex: 0 })
  const layout: DockLayoutNode = { id: 'outer', type: 'split', direction: 'horizontal', ratios: [0.3, 0.7], children: [tabs('a'), {
    id: 'inner', type: 'split', direction: 'vertical', ratios: [0.4, 0.6], children: [tabs('b'), tabs('c')],
  }] }
  const store = createDockStore()
  const mounted = vi.fn()
  const unmounted = vi.fn()
  function Panel({ id }: { id: string }) {
    useEffect(() => { mounted(id); return () => unmounted(id) }, [id])
    return <div data-panel={id} />
  }
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    act(() => root.render(<DockStoreProvider store={store}><DockLayoutRenderer layout={layout} renderTabs={(stack) => <Panel id={stack.id} />} /></DockStoreProvider>))
    const a = host.querySelector('[data-panel="a"]')!.parentElement!
    const b = host.querySelector('[data-panel="b"]')!.parentElement!
    const c = host.querySelector('[data-panel="c"]')!.parentElement!
    act(() => store.getState().toggleStackMaximized('c'))
    expect(a.style.display).toBe('none')
    expect(b.style.display).toBe('none')
    expect(c.style.height).toBe('100%')
    expect(host.querySelector('.cursor-col-resize')).toBeNull()
    expect(mounted).toHaveBeenCalledTimes(3)
    expect(unmounted).not.toHaveBeenCalled()
    act(() => store.getState().toggleStackMaximized('c'))
    expect(a.style.display).toBe('')
    expect(a.style.width).toContain('0.3')
    expect(b.style.height).toContain('0.4')
    expect(c.style.height).toContain('0.6')
    expect(mounted).toHaveBeenCalledTimes(3)
    act(() => store.getState().toggleStackMaximized('missing'))
    expect(a.style.display).toBe('')
    expect(b.style.display).toBe('')
    store.getState().restoreSnapshot(store.getState().getSnapshot())
    expect(store.getState().maximizedStackId).toBeNull()
  } finally { act(() => root.unmount()) }
})
