import { describe, expect, it } from 'vitest'
import { createDockStore } from './dockStore'

function fixture() {
  const store = createDockStore()
  store.getState().dockPanel('a', 'center')
  const a = store.getState().getPanelLocation('a')!
  if (a.type !== 'dock') throw new Error('Expected dock location')
  store.getState().dockPanel('b', 'center', { type: 'split', stackId: a.stackId, edge: 'right' })
  return { store, stackId: a.stackId }
}

function promotedFixture() {
  const store = createDockStore()
  store.getState().dockPanel('canvas', 'center')
  const canvas = store.getState().getPanelLocation('canvas')!
  if (canvas.type !== 'dock') throw new Error('Expected dock location')
  store.getState().dockPanel('peer', 'center', {
    type: 'split', stackId: canvas.stackId, edge: 'right',
  })
  const peer = store.getState().getPanelLocation('peer')!
  if (peer.type !== 'dock') throw new Error('Expected dock location')
  const restoreLayout = store.getState().zones.center.layout!
  if (restoreLayout.type !== 'split') throw new Error('Expected split layout')
  store.getState().dockPanel('promoted', 'center', { type: 'tab', stackId: canvas.stackId })
  store.getState().beginPresentation({
    stackId: canvas.stackId,
    panelId: 'promoted',
    zone: 'center',
    restoreLayout,
    expectedLayout: store.getState().zones.center.layout!,
  })
  return {
    store,
    stackId: canvas.stackId,
    peerStackId: peer.stackId,
    splitId: restoreLayout.id,
  }
}

type PromotedFixture = ReturnType<typeof promotedFixture>

const safeWhilePresented: Array<[string, (fixture: PromotedFixture) => void]> = [
  ['selecting the canvas tab', ({ store, stackId }) => store.getState().setActiveTab(stackId, 0)],
  ['selecting the promoted tab again', ({ store, stackId }) => store.getState().setActiveTab(stackId, 1)],
  ['resizing the surrounding split', ({ store, splitId }) => store.getState().setSplitRatio(splitId, [0.3, 0.7])],
  ['resizing a dock zone', ({ store }) => store.getState().setZoneSize('right', 420)],
  ['toggling an unrelated dock zone', ({ store }) => store.getState().toggleZone('right')],
  ['adding a panel to another dock zone', ({ store }) => store.getState().dockPanel('unrelated', 'right')],
  ['taking a persistence snapshot', ({ store }) => { store.getState().getSnapshot() }],
]

const invalidatingWhilePresented: Array<[string, (fixture: PromotedFixture) => void]> = [
  ['adding a tab beside the promoted panel', ({ store, stackId }) => {
    store.getState().dockPanel('new', 'center', { type: 'tab', stackId })
  }],
  ['adding a background tab beside the promoted panel', ({ store, stackId }) => {
    store.getState().dockPanel('new', 'center', { type: 'tab', stackId }, false)
  }],
  ['removing the promoted panel', ({ store }) => store.getState().undockPanel('promoted')],
  ['removing the canvas tab', ({ store }) => store.getState().undockPanel('canvas')],
  ['removing a sibling split panel', ({ store }) => store.getState().undockPanel('peer')],
  ['reordering the promoted panel', ({ store, stackId }) => {
    store.getState().moveTab('promoted', stackId, stackId, 0)
  }],
  ['moving the promoted panel to another stack', ({ store, stackId, peerStackId }) => {
    store.getState().moveTab('promoted', stackId, peerStackId)
  }],
  ['moving another panel into the presented stack', ({ store, stackId, peerStackId }) => {
    store.getState().moveTab('peer', peerStackId, stackId)
  }],
  ['splitting the promoted panel', ({ store, stackId }) => {
    store.getState().dockPanel('promoted', 'center', { type: 'split', stackId, edge: 'right' })
  }],
  ['splitting a sibling panel', ({ store, peerStackId }) => {
    store.getState().dockPanel('new', 'center', { type: 'split', stackId: peerStackId, edge: 'bottom' })
  }],
  ['collapsing the presented stack', ({ store, stackId }) => store.getState().collapseStack(stackId)],
  ['collapsing a sibling stack', ({ store, peerStackId }) => store.getState().collapseStack(peerStackId)],
]

describe('dock presentation', () => {
  it('merges a split into tabs and restores the original tree', () => {
    const { store, stackId } = fixture()
    const original = store.getState().zones.center.layout
    store.getState().mergeSplitToStack(stackId)
    expect(store.getState().zones.center.layout).toMatchObject({
      type: 'tabs', panelIds: ['a', 'b'], activeIndex: 0,
    })
    expect(store.getState().canRestorePresentation(stackId)).toBe(true)
    expect(store.getState().restorePresentation(stackId)).toBe(true)
    expect(store.getState().zones.center.layout).toBe(original)
  })

  it('discards restore permanently after the merged topology changes', () => {
    const { store, stackId } = fixture()
    store.getState().mergeSplitToStack(stackId)
    store.getState().dockPanel('new', 'center', { type: 'tab', stackId })
    expect(store.getState().presentation).toBeNull()
    expect(store.getState().canRestorePresentation(stackId)).toBe(false)
    expect(store.getState().restorePresentation(stackId)).toBe(false)
    expect(store.getState().getPanelLocation('new')).toBeDefined()
  })

  it('does not restore after a promoted panel is moved and moved back', () => {
    const store = createDockStore()
    store.getState().dockPanel('canvas', 'center')
    const location = store.getState().getPanelLocation('canvas')!
    if (location.type !== 'dock') throw new Error('Expected dock location')
    const restoreLayout = store.getState().zones.center.layout!
    store.getState().dockPanel('promoted', 'center', { type: 'tab', stackId: location.stackId })
    const expectedLayout = store.getState().zones.center.layout!
    store.getState().beginPresentation({
      stackId: location.stackId,
      panelId: 'promoted',
      zone: 'center',
      restoreLayout,
      expectedLayout,
    })

    store.getState().undockPanel('promoted')
    expect(store.getState().presentation).toBeNull()
    store.getState().dockPanel('promoted', 'right')
    store.getState().dockPanel('promoted', 'center', { type: 'tab', stackId: location.stackId })
    expect(store.getState().canRestorePresentation(location.stackId)).toBe(false)
  })

  it('discards restore when a promoted panel is split', () => {
    const store = createDockStore()
    store.getState().dockPanel('canvas', 'center')
    const location = store.getState().getPanelLocation('canvas')!
    if (location.type !== 'dock') throw new Error('Expected dock location')
    const restoreLayout = store.getState().zones.center.layout!
    store.getState().dockPanel('promoted', 'center', { type: 'tab', stackId: location.stackId })
    store.getState().beginPresentation({
      stackId: location.stackId,
      panelId: 'promoted',
      zone: 'center',
      restoreLayout,
      expectedLayout: store.getState().zones.center.layout!,
    })

    store.getState().dockPanel('promoted', 'center', {
      type: 'split',
      stackId: location.stackId,
      edge: 'right',
    })
    expect(store.getState().presentation).toBeNull()
    expect(store.getState().zones.center.layout?.type).toBe('split')
  })

  it('allows tab selection while preserving reversibility', () => {
    const { store, stackId } = fixture()
    store.getState().mergeSplitToStack(stackId)
    store.getState().setActiveTab(stackId, 1)
    expect(store.getState().canRestorePresentation(stackId)).toBe(true)
  })

  it.each(safeWhilePresented)('keeps restore after %s', (_label, mutate) => {
    const current = promotedFixture()
    mutate(current)
    expect(current.store.getState().presentation).not.toBeNull()
    expect(current.store.getState().canRestorePresentation(current.stackId)).toBe(true)
  })

  it.each(invalidatingWhilePresented)('permanently discards restore after %s', (_label, mutate) => {
    const current = promotedFixture()
    mutate(current)
    expect(current.store.getState().presentation).toBeNull()
    expect(current.store.getState().canRestorePresentation(current.stackId)).toBe(false)
  })

  it('discards immediately when the external canvas source is no longer restorable', () => {
    const current = promotedFixture()
    const presentation = current.store.getState().presentation!
    current.store.getState().discardPresentation()
    current.store.getState().beginPresentation({
      ...presentation,
      canRestoreExternal: () => false,
    })
    expect(current.store.getState().presentation).toBeNull()
  })

  it('disposes external invalidation tracking exactly once', () => {
    const current = promotedFixture()
    const presentation = current.store.getState().presentation!
    let disposals = 0
    current.store.setState({
      presentation: { ...presentation, dispose: () => { disposals += 1 } },
    })
    current.store.getState().undockPanel('promoted')
    expect(disposals).toBe(1)
  })

  it('discards and disposes presentation state when a snapshot is restored', () => {
    const current = promotedFixture()
    const snapshot = current.store.getState().getSnapshot()
    const presentation = current.store.getState().presentation!
    let disposals = 0
    current.store.setState({
      presentation: { ...presentation, dispose: () => { disposals += 1 } },
    })
    current.store.getState().restoreSnapshot(snapshot)
    expect(current.store.getState().presentation).toBeNull()
    expect(disposals).toBe(1)
  })

  it('keeps the transaction when restore is requested by the wrong stack', () => {
    const current = promotedFixture()
    expect(current.store.getState().restorePresentation(current.peerStackId)).toBe(false)
    expect(current.store.getState().presentation).not.toBeNull()
  })

  it('runs external restore and disposes tracking exactly once on valid restore', () => {
    const current = promotedFixture()
    const presentation = current.store.getState().presentation!
    let restorations = 0
    let disposals = 0
    current.store.setState({
      presentation: {
        ...presentation,
        restoreExternal: () => { restorations += 1 },
        dispose: () => { disposals += 1 },
      },
    })
    expect(current.store.getState().restorePresentation(current.stackId)).toBe(true)
    expect(restorations).toBe(1)
    expect(disposals).toBe(1)
    expect(current.store.getState().presentation).toBeNull()
  })

  it('disposes tracking on explicit discard', () => {
    const current = promotedFixture()
    const presentation = current.store.getState().presentation!
    let disposals = 0
    current.store.setState({
      presentation: { ...presentation, dispose: () => { disposals += 1 } },
    })
    current.store.getState().discardPresentation()
    expect(disposals).toBe(1)
    expect(current.store.getState().presentation).toBeNull()
  })

  it('does not replace or nest an active presentation', () => {
    const current = promotedFixture()
    const presentation = current.store.getState().presentation
    const layout = current.store.getState().zones.center.layout
    current.store.getState().mergeSplitToStack(current.peerStackId)
    current.store.getState().beginPresentation({
      stackId: 'replacement',
      zone: 'center',
      restoreLayout: layout!,
      expectedLayout: layout!,
    })
    expect(current.store.getState().presentation).toBe(presentation)
    expect(current.store.getState().zones.center.layout).toBe(layout)
  })
})
