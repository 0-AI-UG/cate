import { describe, expect, it } from 'vitest'
import type { DockLayoutNode } from '../../shared/types'
import { createDockStore } from './dockStore'

type PlacementTarget =
  | { type: 'tab' }
  | { type: 'split'; edge: 'left' | 'right' | 'top' | 'bottom' }

function layoutAfter(target: PlacementTarget): DockLayoutNode {
  const store = createDockStore()
  store.getState().dockPanel('a', 'center')
  const first = store.getState().getPanelLocation('a')
  if (first?.type !== 'dock') throw new Error('Expected dock location')
  const dropTarget = target.type === 'tab'
    ? { type: 'tab' as const, stackId: first.stackId }
    : { ...target, stackId: first.stackId }
  store.getState().dockPanel('b', 'center', dropTarget)
  const layout = store.getState().zones.center.layout
  if (!layout) throw new Error('Expected dock layout')
  return layout
}

const placements: Array<{
  label: string
  target: PlacementTarget
  direction?: 'horizontal' | 'vertical'
  panelOrder: string[]
}> = [
  { label: 'tab', target: { type: 'tab' }, panelOrder: ['a', 'b'] },
  { label: 'left split', target: { type: 'split', edge: 'left' }, direction: 'horizontal', panelOrder: ['b', 'a'] },
  { label: 'right split', target: { type: 'split', edge: 'right' }, direction: 'horizontal', panelOrder: ['a', 'b'] },
  { label: 'top split', target: { type: 'split', edge: 'top' }, direction: 'vertical', panelOrder: ['b', 'a'] },
  { label: 'bottom split', target: { type: 'split', edge: 'bottom' }, direction: 'vertical', panelOrder: ['a', 'b'] },
]

function panelOrder(layout: DockLayoutNode): string[] {
  return layout.type === 'tabs'
    ? layout.panelIds
    : layout.children.flatMap(panelOrder)
}

describe('dock placement rule matrix', () => {
  it.each(placements)('$label has deterministic direction and ordering', ({ target, direction, panelOrder: order }) => {
    const layout = layoutAfter(target)
    expect(layout.type).toBe(direction ? 'split' : 'tabs')
    if (layout.type === 'split') expect(layout.direction).toBe(direction)
    expect(panelOrder(layout)).toEqual(order)
  })
})

function mergedFixture() {
  const store = createDockStore()
  store.getState().dockPanel('a', 'center')
  const first = store.getState().getPanelLocation('a')
  if (first?.type !== 'dock') throw new Error('Expected dock location')
  store.getState().dockPanel('b', 'center', { type: 'split', stackId: first.stackId, edge: 'right' })
  store.getState().mergeSplitToStack(first.stackId)
  return { store, stackId: first.stackId }
}

const safeAfterMerge: Array<[string, (fixture: ReturnType<typeof mergedFixture>) => void]> = [
  ['selecting another merged tab', ({ store, stackId }) => store.getState().setActiveTab(stackId, 1)],
  ['resizing an unrelated zone', ({ store }) => store.getState().setZoneSize('right', 420)],
  ['toggling an unrelated zone', ({ store }) => store.getState().toggleZone('right')],
  ['adding a panel to another zone', ({ store }) => store.getState().dockPanel('unrelated', 'right')],
  ['taking a persistence snapshot', ({ store }) => { store.getState().getSnapshot() }],
]

const invalidAfterMerge: Array<[string, (fixture: ReturnType<typeof mergedFixture>) => void]> = [
  ['adding an active tab', ({ store, stackId }) => {
    store.getState().dockPanel('new', 'center', { type: 'tab', stackId })
  }],
  ['adding a background tab', ({ store, stackId }) => {
    store.getState().dockPanel('new', 'center', { type: 'tab', stackId }, false)
  }],
  ['removing the first tab', ({ store }) => store.getState().undockPanel('a')],
  ['removing the second tab', ({ store }) => store.getState().undockPanel('b')],
  ['reordering tabs', ({ store, stackId }) => store.getState().moveTab('b', stackId, stackId, 0)],
  ['moving a tab to another zone', ({ store }) => store.getState().dockPanel('b', 'right')],
  ['splitting the merged stack', ({ store, stackId }) => {
    store.getState().dockPanel('new', 'center', { type: 'split', stackId, edge: 'right' })
  }],
  ['collapsing the merged stack', ({ store, stackId }) => store.getState().collapseStack(stackId)],
  ['restoring a snapshot', ({ store }) => store.getState().restoreSnapshot(store.getState().getSnapshot())],
]

describe('merged dock presentation rule matrix', () => {
  it.each(safeAfterMerge)('remains restorable after %s', (_label, action) => {
    const fixture = mergedFixture()
    action(fixture)
    expect(fixture.store.getState().canRestorePresentation(fixture.stackId)).toBe(true)
  })

  it.each(invalidAfterMerge)('is permanently invalidated by %s', (_label, action) => {
    const fixture = mergedFixture()
    action(fixture)
    expect(fixture.store.getState().presentation).toBeNull()
    expect(fixture.store.getState().restorePresentation(fixture.stackId)).toBe(false)
  })
})
