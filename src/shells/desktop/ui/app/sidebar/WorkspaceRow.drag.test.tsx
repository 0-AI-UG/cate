import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MAIN_WINDOW, dockPanels } from '@workspace/document/contract'
import { DragOverlay, beginDrag, registerDropZone, resetDragDispatch, resetDragRegistry, useDragStore } from '../../client/layout/drag'
import { createClientIdentity, installClientIdentity } from '@client/connections'
import { registerPanelDefinitions } from '@client/host'
import type { WorkspaceEntry } from '@client/workspaces'
import { add, attachTestWorkspace, buildDocument, testPanelDefinitions, type TestWorkspace } from '../../../../../test/clientWorkspace'
import { installClientApp, type ClientApp } from '../app'
import { WorkspaceRow } from './WorkspaceRow'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
beforeAll(() => registerPanelDefinitions(testPanelDefinitions()))

const entry: WorkspaceEntry = { kind: 'local', id: 'w', root: '/p', name: 'w', lastOpenedAt: 1 }
const L1 = { layoutId: 'main' }
const L2 = { layoutId: 'two' }
const state = { kind: 'connected' }
const connected = { getState: () => state, subscribe: () => () => {} }

let ws: TestWorkspace
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  installClientIdentity(createClientIdentity({ device: { name: 'd', publicKey: 'FP' }, features: [] }))
  installClientApp({
    workspaces: { getSnapshot: () => ({ entries: [entry], open: ['w'] }), subscribe: () => () => {} } as never,
    connections: { get: () => connected } as unknown as ClientApp['connections'],
    version: '2.1.0',
  })
  // Layout "main" (a group): stack s1 [a, b] beside stack s2 [c]; layout "two" (a plain row): [d].
  ws = attachTestWorkspace('w', buildDocument([
    add('a', { to: 'stack', dock: L1, stackId: 's1' }),
    add('b', { to: 'stack', dock: L1, stackId: 's1' }),
    add('c', { to: 'split', dock: L1, beside: 's1', side: 'right', stackId: 's2', splitId: 'sp' }),
    { kind: 'addLayout', host: { windowId: MAIN_WINDOW }, layoutId: 'two', name: 'Two' },
    add('d', { to: 'stack', dock: L2, stackId: 's3' }),
  ]))
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(<Tree />))
  measure()
})

afterEach(() => {
  // A test that failed mid-drag leaves it running: cancel it the way the user would.
  act(() => { globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
  resetDragDispatch()
  act(() => root.unmount())
  resetDragRegistry()
  host.remove()
  ws.detach()
  installClientApp(null)
  installClientIdentity(null)
})

const Tree = () => <><WorkspaceRow entry={entry} isOpen isSelected={false} isExpanded onToggleExpand={() => {}} onClick={() => {}} /><DragOverlay /></>
const rect = (left: number, right: number, top: number, bottom: number) =>
  ({ left, right, top, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect

/** jsdom has no layout: every panel row is 28px with 2px of margin around it, so rows (and
 *  layouts) touch at 32px; the tree spans x 0..200. An anchor's rect spans the rows it holds. */
function measure(labelGap = 0) {
  let y = 0
  let labelDone = false
  const leaves = new Map<Element, [number, number]>()
  for (const layout of host.querySelectorAll('[data-sb-key^="l:"]')) {
    // The "Other windows" label sits above the first layout of another window.
    if (labelGap && (layout as HTMLElement).dataset.sbKey!.includes('W2') && !labelDone) {
      const top = y
      host.querySelector<HTMLElement>('[data-sb-key="other-windows"]')!.getBoundingClientRect = () => rect(0, 200, top, top + labelGap)
      y += labelGap
      labelDone = true
    }
    for (const leaf of layout.querySelectorAll('[data-panel-id]')) { leaves.set(leaf, [y + 2, y + 30]); y += 32 }
  }
  for (const [leaf, [top, bottom]] of leaves) (leaf as HTMLElement).getBoundingClientRect = () => rect(0, 200, top, bottom)
  for (const el of host.querySelectorAll<HTMLElement>('[data-sb-key]')) {
    const inner = [...leaves].filter(([leaf]) => el.contains(leaf)).map(([, span]) => span)
    if (inner.length === 0) continue
    el.getBoundingClientRect = () => rect(0, 200, Math.min(...inner.map((r) => r[0])) - 2, Math.max(...inner.map((r) => r[1])) + 2)
  }
  host.querySelector<HTMLElement>('[role="group"]')!.getBoundingClientRect = () => rect(0, 200, 0, 400)
}

const fire = (target: EventTarget, type: string, x: number, y: number) =>
  act(() => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 })) })
const keyOf = (key: string) => host.querySelector<HTMLElement>(`[data-sb-key="${key}"]`)!
const rowOf = (id: string) => host.querySelector<HTMLElement>(`[data-panel-id="${id}"]`)!
const gutter = (layoutId: string) => host.querySelector<HTMLElement>(`[data-layout-gutter="${layoutId}"]`)!
const order = () => [...host.querySelectorAll('[data-panel-id]')].map((el) => (el as HTMLElement).dataset.panelId)
const layouts = () => ws.confirmed().windows[MAIN_WINDOW].layouts
const layoutIds = () => layouts().map((l) => l.id)
const float = () => document.querySelector('[data-sidebar-drag-float]')
/** The shared overlay's floating chip: drawn only where no zone gives its own feedback. */
const chip = () => document.querySelector('[data-drag-overlay-ghost]')

describe('the workspace tree', () => {
  it('a layout of several panels is a group of regular rows with a strip at their left; one panel is a plain row', () => {
    expect(layoutIds()).toEqual(['main', 'two'])
    expect([...host.querySelectorAll('[data-layout-group]')].map((g) => (g as HTMLElement).dataset.layoutGroup)).toEqual(['main'])
    const group = host.querySelector('[data-layout-group="main"]')!
    expect([...group.querySelectorAll('[data-panel-id]')].map((el) => (el as HTMLElement).dataset.panelId)).toEqual(['a', 'b', 'c'])
    expect(group.contains(rowOf('d'))).toBe(false)
    // No container: the group draws no background of its own, and its rows are the regular rows.
    expect(group.className).toBe('relative')
    for (const id of ['a', 'b', 'c', 'd']) expect(rowOf(id).className).toContain('rounded-lg')
    // Members' chips start past the strip, their content where a plain row's is.
    expect(['a', 'b', 'c'].map((id) => [keyOf(id).style.paddingLeft, rowOf(id).style.paddingLeft])).toEqual([['16px', '12px'], ['16px', '12px'], ['16px', '12px']])
    expect([keyOf('d').style.paddingLeft, rowOf('d').style.paddingLeft]).toEqual(['', '28px'])
    // The strip floats at their left and is the layout's mouse area.
    const strip = gutter('main').querySelector<HTMLElement>('[data-layout-strip]')!
    // As thick as its rounding is wide, on its left corners only (rounded by clipping: a radius paints stray pixels).
    expect(strip.style.width).toBe('4px')
    expect(strip.getAttribute('style')).toContain('clip-path: inset(0 round 4px 0 0 4px)')
    // The shown layout's strip has the accent of the focused split's border; another's is dim.
    expect(strip.style.backgroundColor).toContain('--focus-blue')
    act(() => ws.state.setActiveLayout(MAIN_WINDOW, 'two'))
    expect(gutter('main').querySelector<HTMLElement>('[data-layout-strip]')!.style.backgroundColor).toContain('currentcolor')
    // Hovering it takes the accent too.
    act(() => { gutter('main').dispatchEvent(new Event('pointerover', { bubbles: true })) })
    expect(gutter('main').querySelector<HTMLElement>('[data-layout-strip]')!.style.backgroundColor).toContain('--focus-blue')
    act(() => { gutter('main').dispatchEvent(new Event('pointerout', { bubbles: true })) })
    act(() => ws.state.setActiveLayout(MAIN_WINDOW, 'main'))
    expect(host.querySelector('[data-layout-heading]')).toBeNull()
    expect(host.querySelector('[data-split-divider]')).toBeNull()
    expect(host.querySelector('[data-layout-separator]')).toBeNull()
    expect(order()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('the panels of the shown layout have the capsule color, subdued, the shown panel its stronger one; a plain row the tab\'s', () => {
    const faint = (id: string) => rowOf(id).className.includes('color-mix') && rowOf(id).className.includes('text-secondary')
    const active = (id: string) => rowOf(id).className.includes('bg-hover text-primary') || rowOf(id).className.includes('bg-surface-2 text-primary')
    expect([faint('a'), faint('b'), faint('c'), faint('d')]).toEqual([false, true, true, false])
    expect([active('a'), active('b')]).toEqual([true, false])
    expect(rowOf('a').className).toContain('bg-hover text-primary')
    act(() => ws.state.focus('c'))
    expect([active('a'), active('c'), faint('a'), faint('b')]).toEqual([false, true, true, true])
    // Another layout shown: its plain row is the active one and the group's panels have nothing.
    act(() => ws.state.setActiveLayout(MAIN_WINDOW, 'two'))
    expect(active('d')).toBe(true)
    expect(rowOf('d').className).toContain('bg-surface-2 text-primary')
    expect(['a', 'b', 'c'].map((id) => faint(id) || active(id))).toEqual([false, false, false])
    // Hovering the strip shows the members.
    act(() => { gutter('main').dispatchEvent(new MouseEvent('pointerenter', { bubbles: false })) })
    act(() => { gutter('main').dispatchEvent(new Event('pointerover', { bubbles: true })) })
    expect(['a', 'b', 'c'].map(faint)).toEqual([true, true, true])
  })

  it('a row dragged inside its group becomes a pane between the rows it passes; the ghost floats and the rows below make room', () => {
    fire(rowOf('a'), 'mousedown', 50, 12)
    fire(globalThis, 'mousemove', 50, 16)
    // The row itself is the ghost: the same element, restyled and out of the flow (no copy drawn over it).
    expect(float()).toBe(rowOf('a'))
    expect(rowOf('a').style.position).toBe('fixed')
    expect(rowOf('a').style.outline).toContain('dashed')
    expect(rowOf('a').style.paddingLeft).toBe('12px')
    expect(order()).toEqual(['a', 'b', 'c', 'd'])
    // Its top edge on the boundary between b and c (a pane beside b's stack).
    fire(globalThis, 'mousemove', 50, 44)
    expect(keyOf('c').style.marginTop).toBe('32px')
    expect(host.querySelector('[data-sidebar-drag-ghost]')).toBeNull()
    fire(globalThis, 'mouseup', 50, 44)
    expect(dockPanels(layouts()[0].dock)).toEqual(['b', 'a', 'c'])
    expect(float()).toBeNull()
  })

  it('between two rows of one stack a dropped panel becomes a tab of it', () => {
    fire(rowOf('c'), 'mousedown', 50, 70)
    fire(globalThis, 'mousemove', 50, 74)
    // Between a and b, which share a stack.
    fire(globalThis, 'mousemove', 50, 38)
    expect(keyOf('b').style.marginTop).toBe('32px')
    expect(useDragStore.getState().target).toMatchObject({ kind: 'stack-slot' })
    expect(chip()).toBeNull()
    fire(globalThis, 'mouseup', 50, 38)
    expect(dockPanels(layouts()[0].dock)).toEqual(['a', 'c', 'b'])
  })

  it('a row dragged below the last layout pops out as a plain row at the end', () => {
    fire(rowOf('c'), 'mousedown', 50, 70)
    fire(globalThis, 'mousemove', 50, 74)
    fire(globalThis, 'mousemove', 50, 170)
    // The ghost goes half a row less the workspace margin past the last row (the walls give that room) and the drop is still its end slot.
    expect(float()!.getAttribute('style')).toContain('top: 112px')
    fire(globalThis, 'mouseup', 50, 170)
    expect(layoutIds()).toHaveLength(3)
    expect(dockPanels(layouts()[2].dock)).toEqual(['c'])
    expect(dockPanels(layouts()[0].dock)).toEqual(['a', 'b'])
  })

  it('past the tree the sidebar still takes the drag: the ghost holds at the end until the cursor leaves the sidebar', () => {
    host.setAttribute('data-app-sidebar', 'left')
    host.getBoundingClientRect = () => rect(0, 200, 0, 1000)
    fire(rowOf('c'), 'mousedown', 50, 70)
    fire(globalThis, 'mousemove', 50, 74)
    // Below the tree's own box (400) but inside the sidebar.
    fire(globalThis, 'mousemove', 50, 700)
    expect(float()!.getAttribute('style')).toContain('top: 112px')
    fire(globalThis, 'mouseup', 50, 700)
    expect(layoutIds()).toHaveLength(3)
    expect(dockPanels(layouts()[2].dock)).toEqual(['c'])
  })

  it('a row dragged above everything opens the gap before the first layout', () => {
    fire(rowOf('d'), 'mousedown', 50, 110)
    fire(globalThis, 'mousemove', 50, 106)
    fire(globalThis, 'mousemove', 50, 2)
    // A plain row for the first slot: before the group.
    expect(keyOf('l:main/main').style.marginTop).toBe('32px')
    fire(globalThis, 'mouseup', 50, 2)
    expect(layoutIds()).toHaveLength(2)
    expect(layouts()[0].dock && dockPanels(layouts()[0].dock)).toEqual(['d'])
  })

  it('the handle drags the whole layout; a click on it without travel shows the layout', async () => {
    fire(gutter('main'), 'mousedown', 10, 40)
    fire(globalThis, 'mousemove', 10, 44)
    expect(float()).not.toBeNull()
    // One ghost the size of the group (96px less its rows' 4px of margin) stands for it, named like the
    // strip names it; it slides with the cursor.
    expect(float()!.textContent).toBe('Layout 1')
    expect(float()!.getAttribute('style')).toContain('height: 92px')
    expect(float()!.getAttribute('style')).toContain('top: 6px')
    expect(host.querySelector('[data-layout-group="main"]')).toBeNull()
    // Off the tree nothing of it stays in the sidebar: no group, no dashed block (the zone it is over draws the ghost).
    fire(globalThis, 'mousemove', 500, 44)
    expect(float()).toBeNull()
    expect(host.querySelector('[data-sidebar-drag-ghost]')).toBeNull()
    expect(host.querySelector('[data-layout-group="main"]')).toBeNull()
    fire(globalThis, 'mousemove', 10, 80)
    expect(float()!.getAttribute('style')).toContain('top: 42px')
    fire(globalThis, 'mousemove', 10, 120)
    fire(globalThis, 'mouseup', 10, 120)
    expect(layoutIds()).toEqual(['two', 'main'])

    // The click a drag leaves behind is swallowed until the next tick; later clicks are not.
    act(() => ws.state.setActiveLayout(MAIN_WINDOW, 'two'))
    fire(gutter('main'), 'click', 10, 120)
    expect(ws.state.getSnapshot().activeLayouts[MAIN_WINDOW]).toBe('two')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    act(() => ws.state.setActiveLayout(MAIN_WINDOW, 'two'))
    const seq = ws.document.getSnapshot()
    fire(gutter('main'), 'mousedown', 10, 40)
    fire(gutter('main'), 'mouseup', 10, 40)
    fire(gutter('main'), 'click', 10, 40)
    expect(ws.document.getSnapshot()).toBe(seq)
    expect(ws.state.getSnapshot().activeLayouts[MAIN_WINDOW]).toBe('main')
  })

  it('another window\'s only layout, lifted over its own slot below the label, leaves a room there for the drop', () => {
    act(() => {
      ws.document.propose(add('e', { to: 'window', windowId: 'W2', layoutId: 'W2-main', stackId: 'ws2' }))
      ws.document.propose(add('f', { to: 'split', dock: { layoutId: 'W2-main' }, beside: 'ws2', side: 'right', stackId: 'ws3', splitId: 'wsp' }))
    })
    measure(24)
    // The label takes 128..152; the window's group stands below it (152..216).
    fire(gutter('W2-main'), 'mousedown', 10, 170)
    fire(globalThis, 'mousemove', 10, 174)
    fire(globalThis, 'mousemove', 10, 150)
    fire(globalThis, 'mousemove', 10, 230)
    expect(host.querySelector('[data-layout-group="W2-main"]')).toBeNull()
    expect(host.querySelector('[data-sb-room]')).not.toBeNull()
    fire(globalThis, 'mousemove', 10, 100)
    expect(host.querySelector('[data-sb-room]')).toBeNull()
    act(() => { globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
  })

  it('off the tree the lifted row stays in place with normal styling; releasing there changes nothing', () => {
    const seq = ws.document.getSnapshot()
    fire(rowOf('a'), 'mousedown', 50, 12)
    fire(globalThis, 'mousemove', 50, 20)
    expect(host.querySelector('[data-sidebar-drag-ghost]')).toBeNull()
    fire(globalThis, 'mousemove', 500, 20)
    // The row stays where it is with normal styling (no ghost when off-zone).
    expect(host.querySelectorAll('[data-sidebar-drag-ghost]')).toHaveLength(0)
    expect(rowOf('a').style.position).toBe('')
    expect(order()).toEqual(['a', 'b', 'c', 'd'])
    fire(globalThis, 'mouseup', 500, 20)
    expect(ws.document.getSnapshot()).toBe(seq)
    expect(order()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('a panel alone in its layout released over its own spot leaves no ghost and changes nothing', () => {
    const seq = ws.document.getSnapshot()
    fire(rowOf('d'), 'mousedown', 50, 110)
    fire(globalThis, 'mousemove', 50, 114)
    fire(globalThis, 'mousemove', 50, 116)
    expect(host.querySelectorAll('[data-sidebar-drag-ghost]')).toHaveLength(0)
    fire(globalThis, 'mouseup', 50, 116)
    expect(ws.document.getSnapshot()).toBe(seq)
    expect(float()).toBeNull()
    expect(order()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('Escape mid-drag restores the rows and sends no op', () => {
    const seq = ws.document.getSnapshot()
    fire(rowOf('a'), 'mousedown', 50, 12)
    fire(globalThis, 'mousemove', 50, 16)
    fire(globalThis, 'mousemove', 50, 44)
    expect(keyOf('c').style.marginTop).toBe('32px')
    act(() => { globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(float()).toBeNull()
    expect(host.querySelector('[data-sidebar-drag-ghost]')).toBeNull()
    expect(keyOf('c').style.marginTop).toBe('')
    expect(rowOf('a').style.position).toBe('')
    fire(globalThis, 'mouseup', 50, 44)
    expect(ws.document.getSnapshot()).toBe(seq)
    expect(order()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('losing focus mid-drag cancels like Escape: rows restored, no op', () => {
    const seq = ws.document.getSnapshot()
    fire(rowOf('a'), 'mousedown', 50, 12)
    fire(globalThis, 'mousemove', 50, 16)
    fire(globalThis, 'mousemove', 50, 44)
    expect(keyOf('c').style.marginTop).toBe('32px')
    act(() => { globalThis.dispatchEvent(new Event('blur')) })
    expect(useDragStore.getState().isDragging).toBe(false)
    expect(float()).toBeNull()
    expect(host.querySelector('[data-sidebar-drag-ghost]')).toBeNull()
    expect(keyOf('c').style.marginTop).toBe('')
    expect(rowOf('a').style.position).toBe('')
    fire(globalThis, 'mouseup', 50, 44)
    expect(ws.document.getSnapshot()).toBe(seq)
    expect(order()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('a click after a drag does not reveal the panel', async () => {
    const focused = () => ws.state.getSnapshot().focusedPanelId
    // Without a drag a click reveals it.
    fire(rowOf('d'), 'mousedown', 50, 110)
    fire(globalThis, 'mouseup', 50, 110)
    fire(rowOf('d'), 'click', 50, 110)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(focused()).toBe('d')
    act(() => ws.state.focus('a'))
    // After one (released off the tree: nothing moves) the click that follows is swallowed.
    fire(rowOf('d'), 'mousedown', 50, 110)
    fire(globalThis, 'mousemove', 50, 120)
    fire(globalThis, 'mousemove', 500, 120)
    fire(globalThis, 'mouseup', 500, 120)
    fire(rowOf('d'), 'click', 50, 110)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(focused()).toBe('a')
  })

  it('when dragged to a split zone the lifted row stays in place with normal styling and the tree opens no gap', () => {
    // The split: stack s2's pane, right of the sidebar.
    const pane = rect(300, 700, 0, 400)
    registerDropZone({ id: 's2', workspaceId: 'w', dock: L1, host: { windowId: MAIN_WINDOW }, stackId: 's2', getRect: () => pane, tabCount: () => 1 })
    fire(rowOf('a'), 'mousedown', 50, 12)
    fire(globalThis, 'mousemove', 50, 16)
    fire(globalThis, 'mousemove', 50, 44)
    expect(float()).toBe(rowOf('a'))
    expect(keyOf('c').style.marginTop).toBe('32px')
    expect(chip()).toBeNull()
    // Over the split's tab bar: the row stays in place with normal styling and the tree opens no gap.
    fire(globalThis, 'mousemove', 500, 20)
    expect(useDragStore.getState().target).toMatchObject({ kind: 'dock-tab', stackId: 's2' })
    expect(float()).toBeNull()
    expect(host.querySelector('[data-sidebar-drag-ghost]')).toBeNull()
    expect(rowOf('a').style.position).toBe('')
    expect(rowOf('a').style.outline).toBe('')
    expect(chip()).not.toBeNull()
    for (const el of host.querySelectorAll<HTMLElement>('[data-sb-key]')) expect([el.style.marginTop, el.style.marginBottom]).toEqual(['', ''])
    // Released there, it becomes a tab of that stack.
    fire(globalThis, 'mouseup', 500, 20)
    expect(dockPanels(layouts()[0].dock)).toEqual(['b', 'c', 'a'])
  })

  it('a panel dragged from elsewhere floats over the tree as its own row, the only float; so does a row of the tree', () => {
    // A strip chip of d: pressed outside the tree, dragged onto it.
    const chipEl = document.createElement('div')
    chipEl.getBoundingClientRect = () => rect(300, 400, 0, 28)
    act(() => { beginDrag({ button: 0, clientX: 350, clientY: 10, currentTarget: chipEl }, { kind: 'dock-tab', workspaceId: 'w', dock: L2, host: { windowId: MAIN_WINDOW }, stackId: 's3', panelId: 'd' }) })
    fire(globalThis, 'mousemove', 340, 10)
    fire(globalThis, 'mousemove', 100, 80)
    expect(useDragStore.getState().target).toMatchObject({ via: 'tree' })
    expect(document.querySelectorAll('[data-sidebar-drag-float]')).toHaveLength(1)
    expect(float()!.textContent).toBe('d')
    // d's own row is the ghost: no second, look-alike block.
    expect(float()).toBe(rowOf('d'))
    expect(chip()).toBeNull()
    // Off the tree it is gone.
    fire(globalThis, 'mousemove', 500, 80)
    expect(float()).toBeNull()
    act(() => { globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    // A drag that began on the tree: its row is the only float.
    fire(rowOf('a'), 'mousedown', 50, 12)
    fire(globalThis, 'mousemove', 50, 16)
    expect(document.querySelectorAll('[data-sidebar-drag-float]')).toHaveLength(1)
    expect(float()).toBe(rowOf('a'))
  })

  it('a layout dragged from the strip floats as a block named like the strip names it, not by its panel', () => {
    const anchor = document.createElement('div')
    anchor.getBoundingClientRect = () => rect(300, 400, 0, 28)
    act(() => { beginDrag({ button: 0, clientX: 350, clientY: 10, currentTarget: anchor }, { kind: 'layout', workspaceId: 'w', host: { windowId: MAIN_WINDOW }, layoutId: 'main', panelId: 'a' }) })
    fire(globalThis, 'mousemove', 340, 10)
    fire(globalThis, 'mousemove', 100, 110)
    expect(useDragStore.getState().target).toMatchObject({ kind: 'tab-slot', via: 'tree' })
    expect(float()!.textContent).toBe('Layout 1')
    fire(globalThis, 'mousemove', 500, 110)
    expect(float()).toBeNull()
    act(() => { globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    // A named layout goes by its name.
    act(() => { beginDrag({ button: 0, clientX: 350, clientY: 10, currentTarget: anchor }, { kind: 'layout', workspaceId: 'w', host: { windowId: MAIN_WINDOW }, layoutId: 'two', panelId: 'd' }) })
    fire(globalThis, 'mousemove', 340, 10)
    fire(globalThis, 'mousemove', 100, 20)
    expect(float()!.textContent).toBe('Two')
  })

  describe('canvas rows', () => {
    const size = { width: 100, height: 100 }
    const addCanvas = (...children: string[]) => {
      act(() => {
        ws.document.propose(add('cv', { to: 'stack', dock: L1, stackId: 's1' }, 'canvas', { canvasId: 'cvs' }))
        children.forEach((id, i) => ws.document.propose(add(id, { to: 'canvas', canvasId: 'cvs', nodeId: `n${i}`, layoutId: `L-n${i}`, stackId: `ns${i}`, rect: { origin: { x: i * 200, y: 0 }, size } })))
      })
      measure()
    }

    it('a panel dropped among the children becomes a node; a child dragged out leaves its node', () => {
      addCanvas('t')
      const layout = () => dockPanels(layouts()[0].dock)
      const t = keyOf('t').getBoundingClientRect()
      fire(rowOf('a'), 'mousedown', 50, 5)
      fire(globalThis, 'mousemove', 150, 10)
      fire(globalThis, 'mousemove', 150, t.bottom - 37)
      // The canvas shows its container while a drag could drop into it, and opens room under its children (the rows moved up over the lifted one's room, the lifted row's 32px).
      expect(host.querySelector('[data-canvas-container="cv"]')).not.toBeNull()
      expect(host.querySelector<HTMLElement>('[data-canvas-end]')!.style.height).toBe('32px')
      expect(chip()).toBeNull()
      fire(globalThis, 'mouseup', 150, t.bottom - 37)
      expect(host.querySelector('[data-canvas-container]')).toBeNull()
      expect(Object.keys(ws.confirmed().canvases.cvs.nodes)).toHaveLength(2)
      expect(layout()).not.toContain('a')

      // A child dragged out into the group: its node goes with it.
      act(() => root.render(<Tree />))
      measure()
      const nodes = Object.keys(ws.confirmed().canvases.cvs.nodes).length
      const c = keyOf('c').getBoundingClientRect()
      fire(rowOf('t'), 'mousedown', 50, keyOf('t').getBoundingClientRect().top + 5)
      fire(globalThis, 'mousemove', 20, c.top)
      fire(globalThis, 'mousemove', 20, c.bottom)
      fire(globalThis, 'mouseup', 20, c.bottom)
      expect(Object.keys(ws.confirmed().canvases.cvs.nodes)).toHaveLength(nodes - 1)
      expect(layouts().some((l) => dockPanels(l.dock).includes('t'))).toBe(true)
    })

    it('a canvas node drag shows no canvas containers; a strip tab drag does', () => {
      addCanvas('t')
      const containers = () => host.querySelectorAll('[data-canvas-container]').length
      act(() => useDragStore.setState({ isDragging: true, source: { workspaceId: 'w', panelId: 't', origin: { kind: 'canvas-node', canvasId: 'cvs', nodeId: 'n0' } } }))
      expect(containers()).toBe(0)
      act(() => useDragStore.setState({ source: { workspaceId: 'w', panelId: 'd', origin: { kind: 'dock-tab', dock: L2, host: { windowId: MAIN_WINDOW }, stackId: 's3' } } }))
      expect(containers()).toBe(1)
      act(() => useDragStore.setState({ isDragging: false, source: null }))
    })

    it('a collapsed canvas still takes a tab dragged from elsewhere: its container and end gap are drawn', () => {
      addCanvas('t')
      act(() => { host.querySelector<HTMLElement>('[aria-label="Collapse canvas"]')!.click() })
      measure()
      try {
        expect(host.querySelector('[data-panel-id="t"]')).toBeNull()
        // Rows: a, b, cv 64-96 (collapsed), c, d. A strip tab of d, held by its middle, over cv's foot.
        act(() => { beginDrag({ button: 0, clientX: 150, clientY: 500, currentTarget: null }, { kind: 'dock-tab', workspaceId: 'w', dock: L2, host: { windowId: MAIN_WINDOW }, stackId: 's3', panelId: 'd' }) })
        fire(globalThis, 'mousemove', 150, 490)
        fire(globalThis, 'mousemove', 150, 104)
        expect(useDragStore.getState().target).toMatchObject({ kind: 'canvas-slot', canvasPanelId: 'cv' })
        expect(host.querySelector('[data-canvas-container="cv"]')).not.toBeNull()
        expect(host.querySelector<HTMLElement>('[data-canvas-end]')!.style.height).toBe('32px')
      } finally {
        act(() => { globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
        act(() => { host.querySelector<HTMLElement>('[aria-label="Expand canvas"]')!.click() })
      }
    })

    it('a child released off the tree stays on its canvas', () => {
      addCanvas('t')
      const seq = ws.document.getSnapshot()
      fire(rowOf('t'), 'mousedown', 50, keyOf('t').getBoundingClientRect().top + 5)
      fire(globalThis, 'mousemove', 50, keyOf('t').getBoundingClientRect().top - 30)
      fire(globalThis, 'mousemove', 50, 20)
      fire(globalThis, 'mousemove', 900, 20)
      fire(globalThis, 'mouseup', 900, 20)
      expect(ws.document.getSnapshot()).toBe(seq)
    })

    it('children of a canvas can be rearranged in the list: the order sticks, the document does not change', () => {
      addCanvas('t', 'u')
      const childOrder = () => order().filter((id) => id === 't' || id === 'u')
      expect(childOrder()).toEqual(['t', 'u'])
      const seq = ws.document.getSnapshot()
      const t = keyOf('t').getBoundingClientRect()
      fire(rowOf('u'), 'mousedown', 150, keyOf('u').getBoundingClientRect().top + 5)
      fire(globalThis, 'mousemove', 150, t.top + 10)
      fire(globalThis, 'mousemove', 150, t.top)
      fire(globalThis, 'mouseup', 150, t.top)
      expect(childOrder()).toEqual(['u', 't'])
      expect(ws.document.getSnapshot()).toBe(seq)
    })
  })
})
