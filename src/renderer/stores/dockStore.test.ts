// =============================================================================
// Dock store — end-to-end tests for the dock-zone layout tree: panel placement
// (append / tab-insert / edge splits), flat 3-way splits, the duplicate guard,
// undocking with split collapse + ratio re-normalization, tab moves within and
// across zones, split resizing, stack collapse, derived panel locations, and
// snapshot round-trips. Structural invariants (no duplicate panels, ratios sum
// to 1, valid active tab indices) are re-checked after every mutation.
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest'
import {
  createDockStore,
  createDefaultDockState,
  DEFAULT_SIDE_ZONE_SIZE,
  DEFAULT_BOTTOM_ZONE_SIZE,
} from './dockStore'
import { setActivePanel, getActivePanelId } from '../lib/activePanel'
import type {
  DockLayoutNode,
  DockSplitNode,
  DockTabStack,
  DockZonePosition,
  WindowDockState,
} from '../../shared/types'
import { ALL_ZONES } from '../../shared/types'

type Store = ReturnType<typeof createDockStore>

// --- tree helpers -----------------------------------------------------------

function collectStacks(node: DockLayoutNode | null, out: DockTabStack[] = []): DockTabStack[] {
  if (!node) return out
  if (node.type === 'tabs') {
    out.push(node)
    return out
  }
  for (const child of node.children) collectStacks(child, out)
  return out
}

function collectSplits(node: DockLayoutNode | null, out: DockSplitNode[] = []): DockSplitNode[] {
  if (!node || node.type === 'tabs') return out
  out.push(node)
  for (const child of node.children) collectSplits(child, out)
  return out
}

/** Structural invariants every dock tree must satisfy at all times. */
function expectTreeInvariants(zones: WindowDockState) {
  const seen = new Set<string>()
  for (const pos of ALL_ZONES) {
    const layout = zones[pos].layout
    for (const stack of collectStacks(layout)) {
      expect(stack.panelIds.length).toBeGreaterThan(0)
      expect(stack.activeIndex).toBeGreaterThanOrEqual(0)
      expect(stack.activeIndex).toBeLessThan(stack.panelIds.length)
      for (const id of stack.panelIds) {
        expect(seen.has(id), `panel ${id} appears twice in the dock tree`).toBe(false)
        seen.add(id)
      }
    }
    for (const split of collectSplits(layout)) {
      expect(split.children.length).toBeGreaterThanOrEqual(2)
      expect(split.ratios).toHaveLength(split.children.length)
      expect(split.ratios.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6)
    }
  }
}

function zoneLayout(store: Store, zone: DockZonePosition): DockLayoutNode | null {
  return store.getState().zones[zone].layout
}

function rootStack(store: Store, zone: DockZonePosition): DockTabStack {
  const layout = zoneLayout(store, zone)
  if (!layout || layout.type !== 'tabs') throw new Error(`zone ${zone} root is not a tab stack`)
  return layout
}

function rootSplit(store: Store, zone: DockZonePosition): DockSplitNode {
  const layout = zoneLayout(store, zone)
  if (!layout || layout.type !== 'split') throw new Error(`zone ${zone} root is not a split`)
  return layout
}

function stackContaining(store: Store, panelId: string): DockTabStack {
  for (const pos of ALL_ZONES) {
    const found = collectStacks(zoneLayout(store, pos)).find((s) => s.panelIds.includes(panelId))
    if (found) return found
  }
  throw new Error(`no stack contains ${panelId}`)
}

// --- tests --------------------------------------------------------------------

describe('createDefaultDockState', () => {
  it('creates hidden side zones with default sizes and a visible center', () => {
    const zones = createDefaultDockState()
    expect(zones.left.visible).toBe(false)
    expect(zones.right.visible).toBe(false)
    expect(zones.bottom.visible).toBe(false)
    expect(zones.center.visible).toBe(true)
    expect(zones.left.size).toBe(DEFAULT_SIDE_ZONE_SIZE)
    expect(zones.right.size).toBe(DEFAULT_SIDE_ZONE_SIZE)
    expect(zones.bottom.size).toBe(DEFAULT_BOTTOM_ZONE_SIZE)
    expect(zones.left.layout).toBeNull()
    expect(zones.center.layout).toBeNull()
  })
})

describe('zone visibility and sizing', () => {
  it('toggleZone flips visibility', () => {
    const store = createDockStore()
    store.getState().toggleZone('bottom')
    expect(store.getState().zones.bottom.visible).toBe(true)
    store.getState().toggleZone('bottom')
    expect(store.getState().zones.bottom.visible).toBe(false)
  })

  it('setZoneSize clamps to the minimum zone size', () => {
    const store = createDockStore()
    store.getState().setZoneSize('left', 500)
    expect(store.getState().zones.left.size).toBe(500)
    store.getState().setZoneSize('left', 10)
    expect(store.getState().zones.left.size).toBe(120)
  })
})

describe('dockPanel — default placement', () => {
  it('creates a root tab stack in an empty zone and auto-shows the zone', () => {
    const store = createDockStore()
    store.getState().dockPanel('term-1', 'bottom')

    const stack = rootStack(store, 'bottom')
    expect(stack.panelIds).toEqual(['term-1'])
    expect(stack.activeIndex).toBe(0)
    expect(store.getState().zones.bottom.visible).toBe(true)
    expectTreeInvariants(store.getState().zones)
  })

  it('appends subsequent panels to the root stack and activates the new tab', () => {
    const store = createDockStore()
    store.getState().dockPanel('term-1', 'bottom')
    store.getState().dockPanel('term-2', 'bottom')
    store.getState().dockPanel('term-3', 'bottom')

    const stack = rootStack(store, 'bottom')
    expect(stack.panelIds).toEqual(['term-1', 'term-2', 'term-3'])
    expect(stack.activeIndex).toBe(2)
    expectTreeInvariants(store.getState().zones)
  })

  it('re-docking a panel already in the zone moves it instead of duplicating it', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'bottom')
    store.getState().dockPanel('b', 'bottom')
    store.getState().dockPanel('a', 'bottom') // again, no target

    const stack = rootStack(store, 'bottom')
    expect(stack.panelIds).toEqual(['b', 'a'])
    expectTreeInvariants(store.getState().zones)
  })

  it('when the root is a split, default placement appends to the first stack', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'bottom')
    const stackA = rootStack(store, 'bottom')
    store.getState().dockPanel('b', 'bottom', { type: 'split', stackId: stackA.id, edge: 'right' })

    store.getState().dockPanel('c', 'bottom') // no target — root is now a split

    const first = collectStacks(zoneLayout(store, 'bottom'))[0]
    expect(first.panelIds).toEqual(['a', 'c'])
    expectTreeInvariants(store.getState().zones)
  })
})

describe('dockPanel — tab targets', () => {
  it('inserts at the requested index and activates it', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'bottom')
    store.getState().dockPanel('b', 'bottom')
    const stack = rootStack(store, 'bottom')

    store.getState().dockPanel('c', 'bottom', { type: 'tab', stackId: stack.id, index: 1 })

    const updated = rootStack(store, 'bottom')
    expect(updated.panelIds).toEqual(['a', 'c', 'b'])
    expect(updated.activeIndex).toBe(1)
    expectTreeInvariants(store.getState().zones)
  })

  it('a tab target whose stack no longer exists falls back to zone append, not dropping the panel', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'bottom')

    store.getState().dockPanel('b', 'bottom', { type: 'tab', stackId: 'stack-gone', index: 0 })

    const stack = rootStack(store, 'bottom')
    expect(stack.panelIds).toEqual(['a', 'b'])
    expectTreeInvariants(store.getState().zones)
  })
})

describe('dockPanel — split targets', () => {
  it('edge:right creates a horizontal split [existing, new] at 50/50', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'bottom')
    const stackA = rootStack(store, 'bottom')

    store.getState().dockPanel('b', 'bottom', { type: 'split', stackId: stackA.id, edge: 'right' })

    const split = rootSplit(store, 'bottom')
    expect(split.direction).toBe('horizontal')
    expect(split.ratios).toEqual([0.5, 0.5])
    const [left, right] = split.children as DockTabStack[]
    expect(left.panelIds).toEqual(['a'])
    expect(right.panelIds).toEqual(['b'])
    expectTreeInvariants(store.getState().zones)
  })

  it('edge:left places the new stack before the existing one', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'bottom')
    const stackA = rootStack(store, 'bottom')

    store.getState().dockPanel('b', 'bottom', { type: 'split', stackId: stackA.id, edge: 'left' })

    const split = rootSplit(store, 'bottom')
    const [first, second] = split.children as DockTabStack[]
    expect(first.panelIds).toEqual(['b'])
    expect(second.panelIds).toEqual(['a'])
    expectTreeInvariants(store.getState().zones)
  })

  it('edge:bottom creates a vertical split', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'left')
    const stackA = rootStack(store, 'left')

    store.getState().dockPanel('b', 'left', { type: 'split', stackId: stackA.id, edge: 'bottom' })

    const split = rootSplit(store, 'left')
    expect(split.direction).toBe('vertical')
    const [top, bottom] = split.children as DockTabStack[]
    expect(top.panelIds).toEqual(['a'])
    expect(bottom.panelIds).toEqual(['b'])
    expectTreeInvariants(store.getState().zones)
  })

  it('splitting again in the SAME direction stays flat (3-way split, no nesting)', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'bottom')
    const stackA = rootStack(store, 'bottom')
    store.getState().dockPanel('b', 'bottom', { type: 'split', stackId: stackA.id, edge: 'right' })
    const stackB = stackContaining(store, 'b')

    store.getState().dockPanel('c', 'bottom', { type: 'split', stackId: stackB.id, edge: 'right' })

    const split = rootSplit(store, 'bottom')
    expect(split.children).toHaveLength(3)
    expect(split.children.every((c) => c.type === 'tabs')).toBe(true)
    expect((split.children as DockTabStack[]).map((s) => s.panelIds[0])).toEqual(['a', 'b', 'c'])
    // The new stack takes half of the sibling it split from.
    expect(split.ratios[0]).toBeCloseTo(0.5)
    expect(split.ratios[1]).toBeCloseTo(0.25)
    expect(split.ratios[2]).toBeCloseTo(0.25)
    expectTreeInvariants(store.getState().zones)
  })

  it('splitting in the PERPENDICULAR direction nests a split', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'bottom')
    const stackA = rootStack(store, 'bottom')
    store.getState().dockPanel('b', 'bottom', { type: 'split', stackId: stackA.id, edge: 'right' })
    const stackB = stackContaining(store, 'b')

    store.getState().dockPanel('c', 'bottom', { type: 'split', stackId: stackB.id, edge: 'bottom' })

    const root = rootSplit(store, 'bottom')
    expect(root.direction).toBe('horizontal')
    expect(root.children).toHaveLength(2)
    const nested = root.children[1] as DockSplitNode
    expect(nested.type).toBe('split')
    expect(nested.direction).toBe('vertical')
    expect((nested.children as DockTabStack[]).map((s) => s.panelIds[0])).toEqual(['b', 'c'])
    expectTreeInvariants(store.getState().zones)
  })
})

describe('undockPanel', () => {
  it('removing the last panel empties the layout and auto-hides a side zone', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'bottom')
    store.getState().undockPanel('a')

    expect(zoneLayout(store, 'bottom')).toBeNull()
    expect(store.getState().zones.bottom.visible).toBe(false)
  })

  it('never hides the center zone even when emptied', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'center')
    store.getState().undockPanel('a')

    expect(zoneLayout(store, 'center')).toBeNull()
    expect(store.getState().zones.center.visible).toBe(true)
  })

  it('collapses a 2-way split back to a single tab stack', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'bottom')
    const stackA = rootStack(store, 'bottom')
    store.getState().dockPanel('b', 'bottom', { type: 'split', stackId: stackA.id, edge: 'right' })

    store.getState().undockPanel('b')

    const layout = zoneLayout(store, 'bottom')!
    expect(layout.type).toBe('tabs')
    expect((layout as DockTabStack).panelIds).toEqual(['a'])
    expectTreeInvariants(store.getState().zones)
  })

  it('removing one child of a 3-way split re-normalizes the remaining ratios', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'bottom')
    const stackA = rootStack(store, 'bottom')
    store.getState().dockPanel('b', 'bottom', { type: 'split', stackId: stackA.id, edge: 'right' })
    const stackB = stackContaining(store, 'b')
    store.getState().dockPanel('c', 'bottom', { type: 'split', stackId: stackB.id, edge: 'right' })
    // ratios are now [0.5, 0.25, 0.25]

    store.getState().undockPanel('b')

    const split = rootSplit(store, 'bottom')
    expect(split.children).toHaveLength(2)
    expect(split.ratios[0]).toBeCloseTo(0.5 / 0.75)
    expect(split.ratios[1]).toBeCloseTo(0.25 / 0.75)
    expectTreeInvariants(store.getState().zones)
  })

  it('clamps the active tab when the last tab is removed', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'bottom')
    store.getState().dockPanel('b', 'bottom')
    store.getState().dockPanel('c', 'bottom')
    expect(rootStack(store, 'bottom').activeIndex).toBe(2)

    store.getState().undockPanel('c')

    const stack = rootStack(store, 'bottom')
    expect(stack.panelIds).toEqual(['a', 'b'])
    expect(stack.activeIndex).toBe(1)
    expectTreeInvariants(store.getState().zones)
  })

  it('is a no-op for a panel that is not docked anywhere', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'bottom')
    const before = store.getState().zones

    store.getState().undockPanel('ghost')

    expect(store.getState().zones).toBe(before)
  })
})

describe('moveTab', () => {
  function setupTwoStacks(store: Store): { from: DockTabStack; to: DockTabStack } {
    store.getState().dockPanel('a', 'bottom')
    store.getState().dockPanel('b', 'bottom')
    const stackA = rootStack(store, 'bottom')
    store.getState().dockPanel('c', 'bottom', { type: 'split', stackId: stackA.id, edge: 'right' })
    return { from: stackContaining(store, 'a'), to: stackContaining(store, 'c') }
  }

  it('moves a panel between stacks and activates it at the insert index', () => {
    const store = createDockStore()
    const { from, to } = setupTwoStacks(store)

    store.getState().moveTab('a', from.id, to.id, 0)

    expect(stackContaining(store, 'a').id).toBe(to.id)
    const target = stackContaining(store, 'c')
    expect(target.panelIds).toEqual(['a', 'c'])
    expect(target.activeIndex).toBe(0)
    const source = stackContaining(store, 'b')
    expect(source.panelIds).toEqual(['b'])
    expectTreeInvariants(store.getState().zones)
  })

  it('emptying the source stack removes it and collapses the split', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'bottom')
    const stackA = rootStack(store, 'bottom')
    store.getState().dockPanel('b', 'bottom', { type: 'split', stackId: stackA.id, edge: 'right' })
    const from = stackContaining(store, 'b')
    const to = stackContaining(store, 'a')

    store.getState().moveTab('b', from.id, to.id)

    const layout = zoneLayout(store, 'bottom')!
    expect(layout.type).toBe('tabs')
    expect((layout as DockTabStack).panelIds).toEqual(['a', 'b'])
    expectTreeInvariants(store.getState().zones)
  })

  it('moves a panel across zones', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'bottom')
    store.getState().dockPanel('b', 'bottom')
    store.getState().dockPanel('x', 'left')
    const from = rootStack(store, 'bottom')
    const to = rootStack(store, 'left')

    store.getState().moveTab('a', from.id, to.id)

    expect(rootStack(store, 'bottom').panelIds).toEqual(['b'])
    expect(rootStack(store, 'left').panelIds).toEqual(['x', 'a'])
    expect(store.getState().getPanelLocation('a')).toEqual({
      type: 'dock',
      zone: 'left',
      stackId: to.id,
    })
    expectTreeInvariants(store.getState().zones)
  })

  it('reorders within the same stack', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'bottom')
    store.getState().dockPanel('b', 'bottom')
    store.getState().dockPanel('c', 'bottom')
    const stack = rootStack(store, 'bottom')

    store.getState().moveTab('a', stack.id, stack.id, 2)

    expect(rootStack(store, 'bottom').panelIds).toEqual(['b', 'c', 'a'])
    expectTreeInvariants(store.getState().zones)
  })
})

describe('setActiveTab', () => {
  it('activates a valid index and ignores out-of-range ones', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'bottom')
    store.getState().dockPanel('b', 'bottom')
    const stack = rootStack(store, 'bottom')

    store.getState().setActiveTab(stack.id, 0)
    expect(rootStack(store, 'bottom').activeIndex).toBe(0)

    store.getState().setActiveTab(stack.id, 5)
    expect(rootStack(store, 'bottom').activeIndex).toBe(0)
    store.getState().setActiveTab(stack.id, -1)
    expect(rootStack(store, 'bottom').activeIndex).toBe(0)
  })
})

describe('setSplitRatio', () => {
  it('updates the ratios of the addressed split only', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'bottom')
    const stackA = rootStack(store, 'bottom')
    store.getState().dockPanel('b', 'bottom', { type: 'split', stackId: stackA.id, edge: 'right' })
    const stackB = stackContaining(store, 'b')
    store.getState().dockPanel('c', 'bottom', { type: 'split', stackId: stackB.id, edge: 'bottom' })
    const root = rootSplit(store, 'bottom')
    const nested = root.children[1] as DockSplitNode

    store.getState().setSplitRatio(nested.id, [0.7, 0.3])

    const after = rootSplit(store, 'bottom')
    expect((after.children[1] as DockSplitNode).ratios).toEqual([0.7, 0.3])
    expect(after.ratios).toEqual([0.5, 0.5]) // untouched
    expectTreeInvariants(store.getState().zones)
  })
})

describe('collapseStack', () => {
  it('removes the whole stack, promotes the sibling, and clears a matching active panel', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'bottom')
    store.getState().dockPanel('b', 'bottom')
    const stackAB = rootStack(store, 'bottom')
    store.getState().dockPanel('c', 'bottom', { type: 'split', stackId: stackAB.id, edge: 'right' })

    setActivePanel('b')
    store.getState().collapseStack(stackAB.id)

    expect(getActivePanelId()).toBeNull()
    const layout = zoneLayout(store, 'bottom')!
    expect(layout.type).toBe('tabs')
    expect((layout as DockTabStack).panelIds).toEqual(['c'])
    expectTreeInvariants(store.getState().zones)
  })

  it('leaves an unrelated active panel alone and hides the zone when emptied', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'left')
    const stack = rootStack(store, 'left')

    setActivePanel('other-panel')
    store.getState().collapseStack(stack.id)

    expect(getActivePanelId()).toBe('other-panel')
    expect(zoneLayout(store, 'left')).toBeNull()
    expect(store.getState().zones.left.visible).toBe(false)
    setActivePanel(null)
  })
})

describe('getPanelLocation', () => {
  it('derives zone + stack from the tree and returns undefined for unknown panels', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'bottom')
    store.getState().dockPanel('x', 'right')

    const locA = store.getState().getPanelLocation('a')
    expect(locA).toEqual({ type: 'dock', zone: 'bottom', stackId: rootStack(store, 'bottom').id })
    const locX = store.getState().getPanelLocation('x')
    expect(locX).toEqual({ type: 'dock', zone: 'right', stackId: rootStack(store, 'right').id })
    expect(store.getState().getPanelLocation('nope')).toBeUndefined()
  })
})

describe('snapshot round-trip', () => {
  function buildComplexLayout(store: Store) {
    store.getState().dockPanel('a', 'bottom')
    store.getState().dockPanel('b', 'bottom')
    const stackAB = rootStack(store, 'bottom')
    store.getState().dockPanel('c', 'bottom', { type: 'split', stackId: stackAB.id, edge: 'right' })
    const stackC = stackContaining(store, 'c')
    store.getState().dockPanel('d', 'bottom', { type: 'split', stackId: stackC.id, edge: 'bottom' })
    store.getState().dockPanel('e', 'left')
    store.getState().setZoneSize('left', 320)
  }

  it('getSnapshot derives one location per docked panel', () => {
    const store = createDockStore()
    buildComplexLayout(store)

    const snapshot = store.getState().getSnapshot()

    expect(snapshot).toEqual({ zones: store.getState().zones })
    for (const id of ['a', 'b', 'c', 'd', 'e']) expect(store.getState().getPanelLocation(id)).toBeDefined()
  })

  it('restoreSnapshot reproduces the zones tree exactly in a fresh store', () => {
    const store = createDockStore()
    buildComplexLayout(store)
    const snapshot = store.getState().getSnapshot()

    const restored = createDockStore()
    restored.getState().restoreSnapshot(JSON.parse(JSON.stringify(snapshot)))

    expect(restored.getState().zones).toEqual(store.getState().zones)
    expectTreeInvariants(restored.getState().zones)
    // Derived lookups keep working on the restored tree.
    expect(restored.getState().getPanelLocation('d')).toEqual(store.getState().getPanelLocation('d'))
  })

  it('createDockStore(initialState) seeds from a snapshot', () => {
    const store = createDockStore()
    buildComplexLayout(store)
    const snapshot = store.getState().getSnapshot()

    const seeded = createDockStore(JSON.parse(JSON.stringify(snapshot)))

    expect(seeded.getState().zones).toEqual(store.getState().zones)
    expect(seeded.getState().zones.left.size).toBe(320)
  })
})

describe('degenerate inputs', () => {
  it('moveTab between nonexistent stacks is a no-op', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'bottom')
    const before = store.getState().zones

    store.getState().moveTab('a', 'no-such-from', 'no-such-to')

    expect(store.getState().zones).toEqual(before)
    expectTreeInvariants(store.getState().zones)
  })

  it('collapseStack with an unknown stack id is a no-op', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'bottom')
    const before = store.getState().zones

    store.getState().collapseStack('no-such-stack')

    expect(store.getState().zones).toEqual(before)
  })

  it('setActiveTab with an unknown stack id is a no-op', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'bottom')
    const before = store.getState().zones

    store.getState().setActiveTab('no-such-stack', 0)

    expect(store.getState().zones).toEqual(before)
  })
})

describe('cross-zone moves', () => {
  it('undockPanel + dockPanel (the contract drag commit relies on) leaves a single location', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'left')
    store.getState().dockPanel('b', 'left')

    // commit.ts always removes from the source before docking into the target.
    store.getState().undockPanel('a')
    store.getState().dockPanel('a', 'bottom')

    expectTreeInvariants(store.getState().zones)
    expect(store.getState().getPanelLocation('a')).toMatchObject({ zone: 'bottom' })
    expect(rootStack(store, 'left').panelIds).toEqual(['b'])
  })

  it('undockPanel finds the panel in whatever zone it lives in (no zone hint needed)', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'right')
    store.getState().dockPanel('b', 'center')

    store.getState().undockPanel('a')
    store.getState().undockPanel('b')

    expect(zoneLayout(store, 'right')).toBeNull()
    expect(zoneLayout(store, 'center')).toBeNull()
  })
})

// Each test below asserts the DESIRED behavior and is marked `.fails` because
// the current implementation silently loses or corrupts state instead. When the
// underlying hole is fixed, the test starts passing and vitest flags it —
// remove the `.fails` marker then.
describe('known holes (documented as expected failures)', () => {
  it.fails('dockPanel into a different zone must not duplicate the panel across zones', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'left')

    // The duplicate guard in dockPanel only cleans the TARGET zone's tree.
    // Docking a panel that lives in another zone leaves it in both. Today the
    // drag commit always undocks first, but any caller that skips that (or a
    // refactor that reorders it) corrupts the layout silently.
    store.getState().dockPanel('a', 'bottom')

    expectTreeInvariants(store.getState().zones) // 'a' appears twice today
    expect(store.getState().getPanelLocation('a')).toMatchObject({ zone: 'bottom' })
    expect(collectStacks(zoneLayout(store, 'left')).some((s) => s.panelIds.includes('a'))).toBe(false)
  })

  it.fails('a split target whose stack is gone falls back to zone append instead of dropping the panel', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'bottom')

    // The stack was closed since the user last interacted with it — same
    // situation the tab-target path already guards against.
    store.getState().dockPanel('b', 'bottom', { type: 'split', stackId: 'stack-gone', edge: 'right' })

    expect(store.getState().getPanelLocation('b')).toBeDefined()
  })

  it.fails('moveTab to a stack that no longer exists does not lose the panel', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'bottom')
    store.getState().dockPanel('b', 'bottom')
    const stack = rootStack(store, 'bottom')

    store.getState().moveTab('a', stack.id, 'stack-gone')

    expect(store.getState().getPanelLocation('a')).toBeDefined()
  })

  it.fails('a tab insert index beyond the stack length keeps activeIndex in range', () => {
    const store = createDockStore()
    store.getState().dockPanel('a', 'bottom')
    const stack = rootStack(store, 'bottom')

    store.getState().dockPanel('b', 'bottom', { type: 'tab', stackId: stack.id, index: 5 })

    const updated = rootStack(store, 'bottom')
    expect(updated.panelIds).toEqual(['a', 'b'])
    expect(updated.activeIndex).toBeLessThan(updated.panelIds.length)
  })
})

describe('end-to-end rearrangement scenario', () => {
  it('keeps the tree consistent through a long realistic op sequence', () => {
    const store = createDockStore()
    const s = store.getState

    // Build: bottom = [term1, term2] | agent split right, left = files
    s().dockPanel('term1', 'bottom')
    s().dockPanel('term2', 'bottom')
    expectTreeInvariants(s().zones)
    const termStack = rootStack(store, 'bottom')
    s().dockPanel('agent', 'bottom', { type: 'split', stackId: termStack.id, edge: 'right' })
    expectTreeInvariants(s().zones)
    s().dockPanel('files', 'left')
    expectTreeInvariants(s().zones)

    // Tab the agent into the terminal stack, collapsing its split.
    const agentStack = stackContaining(store, 'agent')
    s().moveTab('agent', agentStack.id, termStack.id, 1)
    expectTreeInvariants(s().zones)
    expect(rootStack(store, 'bottom').panelIds).toEqual(['term1', 'agent', 'term2'])

    // Split term2 to the bottom of the (now single) stack, then move files over.
    const stack = rootStack(store, 'bottom')
    s().undockPanel('term2')
    expectTreeInvariants(s().zones)
    s().dockPanel('term2', 'bottom', { type: 'split', stackId: stack.id, edge: 'bottom' })
    expectTreeInvariants(s().zones)
    s().moveTab('files', rootStack(store, 'left').id, stackContaining(store, 'term2').id)
    expectTreeInvariants(s().zones)

    // Left zone emptied by the move; bottom holds everything, each panel locatable.
    expect(zoneLayout(store, 'left')).toBeNull()
    for (const id of ['term1', 'agent', 'term2', 'files']) {
      const loc = s().getPanelLocation(id)
      expect(loc?.type).toBe('dock')
      expect(loc && 'zone' in loc && loc.zone).toBe('bottom')
    }

    // Tear everything down — zone hides itself at the end.
    for (const id of ['term1', 'agent', 'term2', 'files']) {
      s().undockPanel(id)
      expectTreeInvariants(s().zones)
    }
    expect(zoneLayout(store, 'bottom')).toBeNull()
    expect(s().zones.bottom.visible).toBe(false)
  })
})
