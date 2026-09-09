import { describe, expect, it } from 'vitest'
import { createDockStore } from './dockStore'

function fixture() {
  const store = createDockStore()
  store.getState().dockPanel('a', 'center')
  const a = store.getState().getPanelLocation('a')!
  if (a.type !== 'dock') throw new Error('Expected dock location')
  store.getState().dockPanel('b', 'center', { type: 'split', stackId: a.stackId, edge: 'right' })
  const b = store.getState().getPanelLocation('b')!
  if (b.type !== 'dock') throw new Error('Expected dock location')
  store.getState().toggleStackMaximized(a.stackId)
  return { store, a: a.stackId, b: b.stackId }
}

describe('maximized dock lifecycle', () => {
  it('reveals a sibling selected through shared panel navigation', () => {
    const { store, b } = fixture()
    store.getState().setActiveTab(b, 0)
    expect(store.getState().maximizedStackId).toBeNull()
  })
  it('keeps the current pane maximized when selecting its tab or an invalid destination', () => {
    const { store, a, b } = fixture()
    store.getState().setActiveTab(a, 0)
    store.getState().setActiveTab(b, 42)
    expect(store.getState().maximizedStackId).toBe(a)
  })
  it('reveals a new foreground tab while leaving background creation alone', () => {
    const { store, a, b } = fixture()
    store.getState().dockPanel('background', 'center', { type: 'tab', stackId: b }, false)
    expect(store.getState().maximizedStackId).toBe(a)
    store.getState().dockPanel('foreground', 'center', { type: 'tab', stackId: b })
    expect(store.getState().maximizedStackId).toBeNull()
  })
  it('reveals a different zone opened by the user', () => {
    const { store } = fixture()
    store.getState().dockPanel('side', 'left', undefined, false)
    store.getState().toggleZone('left')
    expect(store.getState().maximizedStackId).toBeNull()
  })
  it.each(['undock', 'collapse', 'move'] as const)('clears maximization when %s removes the maximized stack', operation => {
    const { store, a, b } = fixture()
    if (operation === 'undock') store.getState().undockPanel('a')
    if (operation === 'collapse') store.getState().collapseStack(a)
    if (operation === 'move') store.getState().moveTab('a', a, b)
    expect(store.getState().maximizedStackId).toBeNull()
  })
})
