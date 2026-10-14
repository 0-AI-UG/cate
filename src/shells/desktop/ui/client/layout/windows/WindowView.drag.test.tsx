// Dragging in a window's tab strip: chips are drag sources and the dragged chip
// floats along the strip while the chips it passes make room (the strip model
// has its own tests). Rects are stubbed (jsdom has no layout); events are real
// mouse events. A drag's chip is grabbed where its first move lands.

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MAIN_WINDOW, dockPanels, placementOf } from '@workspace/document/contract'
import { createClientIdentity, installClientIdentity } from '@client/connections'
import { registerPanelDefinitions } from '@client/host'
import { add, attachTestWorkspace, buildDocument, testPanelDefinitions, type TestWorkspace } from '../../../../../../test/clientWorkspace'
import { installDragShell } from '../drag/ports'
import { registerDropZone, resetDragRegistry } from '../drag/registry'
import { beginDrag, resetDragDispatch } from '../drag/useDragOp'
import { useDragStore } from '../drag/store'
import { WindowView } from './WindowView'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => registerPanelDefinitions(testPanelDefinitions()))

const main = { layoutId: 'main' }
const host = { windowId: MAIN_WINDOW }
let ws: TestWorkspace
let container: HTMLDivElement
let root: Root
let restoreShell: () => void

const box = (left: number, right: number): DOMRect => ({ left, right, top: 0, bottom: 24, width: right - left, height: 24, x: left, y: 0, toJSON: () => ({}) }) as DOMRect
const stub = (el: Element, left: number, right: number) => { (el as HTMLElement).getBoundingClientRect = () => box(left, right) }

// Group [p1 | p2] (anchor 0-24, p1 25-125, p2 126-226), then plain tabs p3 (236-336) and p4 (346-446).
function mount() {
  installClientIdentity(createClientIdentity({ device: { name: 'd', publicKey: 'FP' }, features: [] }))
  restoreShell = installDragShell({})
  ws = attachTestWorkspace('w', buildDocument([
    add('p1', { to: 'stack', dock: main, stackId: 's1' }),
    add('p2', { to: 'split', dock: main, beside: 's1', side: 'right', stackId: 's2', splitId: 'sp' }),
    add('p3', { to: 'tab', host, layoutId: 'L3', stackId: 's3' }),
    add('p4', { to: 'tab', host, layoutId: 'L4', stackId: 's4' }),
  ]))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(<WindowView workspaceId="w" windowId={MAIN_WINDOW} overlay={false} />))
  const q = (selector: string) => container.querySelector(selector)!
  stub(q('[data-window-header]'), 0, 800)
  stub(q('[data-layout-group="main"]'), 0, 226)
  stub(q('[data-layout-group="main"] [data-layout-id]'), 0, 24)
  stub(q('[data-strip-panel-id="p1"]'), 25, 125)
  stub(q('[data-strip-panel-id="p2"]'), 126, 226)
  stub(q('[data-strip-panel-id="p3"]'), 236, 336)
  stub(q('[data-strip-panel-id="p4"]'), 346, 446)
}

const fire = (target: EventTarget, type: string, x: number, y = 10) => act(() => {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, screenX: x, screenY: y }))
})
const chip = (id: string) => container.querySelector(`[data-strip-panel-id="${id}"]`) as HTMLElement
const float = () => container.querySelector('[data-strip-float]') as HTMLElement | null
const target = () => useDragStore.getState().target
const layouts = () => ws.confirmed().windows[MAIN_WINDOW].layouts
const firstPanels = () => layouts().map((l) => dockPanels(l.dock)[0])
const separators = () => [...container.querySelectorAll<HTMLElement>('[data-layout-group="main"] [data-group-separator]')]

beforeEach(mount)
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  ws.detach()
  restoreShell()
  resetDragDispatch()
  resetDragRegistry()
  useDragStore.setState({ isDragging: false, target: null, source: null })
  installClientIdentity(null)
})

describe('tab strip dragging', () => {
  it('the dragged chip floats along the strip; passing a group\'s chips opens a gap and drops a pane there', () => {
    fire(chip('p3'), 'mousedown', 280)
    fire(window, 'mousemove', 285)
    // Grabbed 49px in: it floats with its left edge at cursor - 49, and its own chip leaves the row.
    expect(float()!.style.left).toBe('236px')
    // The chip itself is the ghost: the same element, restyled, out of the row (no copy drawn over it).
    expect(float()).toBe(chip('p3'))
    expect(chip('p3').style.position).toBe('fixed')
    expect(chip('p3').textContent).toBe('p3')
    expect(chip('p3').style.outline).toContain('dashed')
    // Its left edge on the gap between p1 and p2 (x = 125): a pane there, the gap made before p2's separator.
    fire(window, 'mousemove', 174)
    expect(target()).toMatchObject({ kind: 'group-slot', layoutId: 'main', beside: 's1', side: 'right', slot: 1 })
    expect(float()!.style.left).toBe('125px')
    expect(separators()[1].style.marginLeft).toBe('100px')
    fire(window, 'mouseup', 174)
    expect(float()).toBeNull()
    expect(dockPanels(layouts()[0].dock)).toEqual(['p1', 'p3', 'p2'])
    expect(layouts().map((l) => l.id)).toEqual(['main', 'L4'])
  })

  it('a pane reorders within its own group; back at its own spot nothing drops; pulled out it becomes a tab', () => {
    const seq = ws.document.seq
    fire(chip('p2'), 'mousedown', 150)
    fire(window, 'mousemove', 155)
    // Its own spot (the gap is where p2 was, after p1): nothing drops there.
    fire(window, 'mousemove', 154)
    expect(target()).toMatchObject({ kind: 'group-home', layoutId: 'main', slot: 1 })
    expect(chip('p1').style.marginRight).toBe('100px')
    fire(window, 'mouseup', 154)
    expect(ws.document.seq).toBe(seq)
    // Before p1: the gap opens before p1's separator... and p2 lands first.
    fire(chip('p2'), 'mousedown', 150)
    fire(window, 'mousemove', 155)
    fire(window, 'mousemove', 60)
    expect(target()).toMatchObject({ kind: 'group-slot', layoutId: 'main', beside: 's1', side: 'left', slot: 0 })
    expect(separators()[0].style.marginLeft).toBe('100px')
    fire(window, 'mouseup', 60)
    expect(dockPanels(layouts()[0].dock)).toEqual(['p2', 'p1'])
    // Pulled out of the group again.
    // Pulled right out of the group, past the other tabs, it pops out as a tab at the end.
    fire(chip('p2'), 'mousedown', 100)
    fire(window, 'mousemove', 105)
    fire(window, 'mousemove', 359)
    expect(target()).toMatchObject({ kind: 'tab-slot', index: 3 })
    fire(window, 'mouseup', 359)
    expect(dockPanels(layouts()[0].dock)).toEqual(['p1'])
    expect(firstPanels()).toEqual(['p1', 'p3', 'p4', 'p2'])
  })

  it('dragged by a pane\'s grip, far from its chip, the ghost is held by its middle and follows the cursor', () => {
    const grip = container.querySelector('[data-pane-drag="p2"]')!
    fire(grip, 'mousedown', 700, 300)
    fire(window, 'mousemove', 705, 300)
    fire(window, 'mousemove', 100, 10)
    // Chip 100 wide: held at 50, not at the ~574px between the grip and the chip.
    expect(float()!.style.left).toBe('50px')
    expect(target()).toMatchObject({ kind: 'group-slot', layoutId: 'main', slot: 0 })
    fire(window, 'mousemove', 450, 10)
    expect(float()!.style.left).toBe('400px')
    expect(target()).toMatchObject({ kind: 'tab-slot' })
    fire(window, 'mouseup', 450, 10)
  })

  it('tabs reorder as the dragged chip passes them', () => {
    fire(chip('p4'), 'mousedown', 390)
    fire(window, 'mousemove', 395)
    expect(target()).toMatchObject({ kind: 'tab-slot', index: 2 }) // home: it is the last of three layouts
    fire(window, 'mousemove', 289)
    expect(target()).toMatchObject({ kind: 'tab-slot', index: 1 })
    // The gap opens before p3.
    expect(chip('p3').style.marginLeft).toBe('100px')
    fire(window, 'mouseup', 289)
    expect(layouts().map((l) => l.id)).toEqual(['main', 'L4', 'L3'])
    expect(placementOf(ws.confirmed(), 'p4')?.dock).toEqual({ layoutId: 'L4' })
  })

  it('the floating chip stops against the strip\'s left wall and the + button', () => {
    stub(container.querySelector('[aria-label="New Tab"]')!, 500, 524)
    fire(chip('p3'), 'mousedown', 280)
    fire(window, 'mousemove', 285)
    fire(window, 'mousemove', 790)
    // The + button's left edge (500) less the row's 4px gap, plus half a chip (50) of room, less its own 100px.
    expect(float()!.style.left).toBe('446px')
    expect(target()).toMatchObject({ kind: 'tab-slot', index: 3 })
    fire(window, 'mousemove', 0)
    expect(float()!.style.left).toBe('0px')
    expect(target()).toMatchObject({ kind: 'tab-slot', index: 0 })
    fire(window, 'mouseup', 0)
  })

  it('the + steps aside by half the dragged chip\'s width while a chip of the strip is dragged, and returns on release', () => {
    const plus = () => container.querySelector<HTMLElement>('[data-new-tab-slot]')!
    const shift = () => parseFloat(plus().style.marginLeft || '0')
    expect(shift()).toBe(0)
    fire(chip('p3'), 'mousedown', 280)
    fire(window, 'mousemove', 285)
    // Half the dragged chip's width: the room the right wall gives.
    expect(shift()).toBe(parseFloat(float()!.style.width) / 2)
    fire(window, 'mouseup', 285)
    expect(shift()).toBe(0)
  })

  it('a group dragged by its anchor chip moves as a whole', () => {
    fire(container.querySelector('[data-layout-group="main"] [data-layout-id]')!, 'mousedown', 10)
    fire(window, 'mousemove', 15)
    expect(float()).not.toBeNull()
    // The ghost carries the layout's name, not its first panel's title.
    expect(float()!.textContent).toBe('Layout 1')
    expect(target()).toMatchObject({ kind: 'tab-slot', index: 0 })
    fire(window, 'mousemove', 119)
    expect(target()).toMatchObject({ kind: 'tab-slot', index: 2 })
    fire(window, 'mouseup', 119)
    expect(layouts().map((l) => l.id)).toEqual(['L3', 'main', 'L4'])
    expect(dockPanels(layouts()[1].dock)).toEqual(['p1', 'p2'])
  })

  it('a group dragged past the last tab lands at the end', () => {
    fire(container.querySelector('[data-layout-group="main"] [data-layout-id]')!, 'mousedown', 10)
    fire(window, 'mousemove', 15)
    fire(window, 'mousemove', 315)
    expect(target()).toMatchObject({ kind: 'tab-slot', index: 3 })
    fire(window, 'mouseup', 315)
    expect(layouts().map((l) => l.id)).toEqual(['L3', 'L4', 'main'])
  })

  it('off the strip (over the dock) the dragged chip leaves the row; releasing there changes nothing', () => {
    const seq = ws.document.seq
    fire(chip('p3'), 'mousedown', 280)
    fire(window, 'mousemove', 285)
    expect(float()).not.toBeNull()
    fire(window, 'mousemove', 285, 300)
    expect(float()).toBeNull()
    // The dock takes the drop and draws the ghost: the strip's chip is out of the row, not a second one.
    expect(chip('p3').style.display).toBe('none')
    fire(window, 'mouseup', 285, 300)
    expect(ws.document.seq).toBe(seq)
    expect(chip('p3').style.display).toBe('')
  })

  it('the strip does not open a gap for a via \'tree\' tab-slot', () => {
    // A sidebar tree below the strip that takes the drop as a tab of this window.
    registerDropZone({
      id: 'tree-w',
      workspaceId: 'w',
      dock: { layoutId: '' },
      host,
      getRect: () => ({ left: 0, right: 200, top: 100, bottom: 400, width: 200, height: 300, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect,
      tree: { resolve: () => ({ kind: 'tab-slot', host, index: 1, via: 'tree' }) },
    })
    fire(chip('p3'), 'mousedown', 280)
    fire(window, 'mousemove', 285)
    expect(float()).not.toBeNull()
    fire(window, 'mousemove', 100, 200)
    expect(target()).toMatchObject({ kind: 'tab-slot', index: 1, via: 'tree' })
    expect(float()).toBeNull()
    expect(chip('p3').style.display).toBe('none')
    const margins = [...container.querySelectorAll<HTMLElement>('[data-strip-panel-id], [data-group-separator]')].map((el) => el.style.marginLeft + el.style.marginRight)
    expect(margins.every((m) => m === '')).toBe(true)
    fire(window, 'mouseup', 100, 200)
  })

  it('a plain click on a chip still shows it, and releasing over itself changes nothing', () => {
    const seq = ws.document.seq
    fire(chip('p3'), 'mousedown', 280)
    fire(window, 'mousemove', 285)
    fire(window, 'mousemove', 292)
    fire(window, 'mouseup', 292)
    expect(ws.document.seq).toBe(seq)
  })
})

describe('a drag that began on the sidebar', () => {
  // The sidebar's tree, left of nothing in this test: a zone that takes the drop as a tab of this window.
  const registerTree = () => registerDropZone({
    id: 'tree-w',
    workspaceId: 'w',
    dock: { layoutId: '' },
    host,
    getRect: () => ({ left: 0, right: 200, top: 100, bottom: 400, width: 200, height: 300, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect,
    tree: { resolve: () => ({ kind: 'tab-slot', host, index: 1, via: 'tree' }) },
  })
  /** The strip as the user sees it: nothing hidden, restyled or lifted. */
  const untouched = (el: HTMLElement) => {
    expect(el.style.display).toBe('')
    expect(el.style.position).toBe('')
    expect(el.style.outline).toBe('')
    expect(el.hasAttribute('data-strip-ghost')).toBe(false)
    expect(el.hasAttribute('data-strip-float')).toBe(false)
  }
  const escape = () => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
  const press = (spec: Parameters<typeof beginDrag>[1]) => {
    act(() => { beginDrag({ button: 0, clientX: 100, clientY: 150, currentTarget: null }, spec) })
    fire(window, 'mousemove', 100, 160)
  }

  it('a panel row leaves its chip standing over the tree and the dock; over the strip the chip is the float', () => {
    registerTree()
    press({ kind: 'dock-tab', workspaceId: 'w', dock: { layoutId: 'L3' }, host, stackId: 's3', panelId: 'p3', from: 'sidebar' })
    expect(target()).toMatchObject({ via: 'tree' })
    untouched(chip('p3'))
    fire(window, 'mousemove', 600, 300)
    expect(target()).toBeNull()
    untouched(chip('p3'))
    fire(window, 'mousemove', 600, 10)
    expect(target()).toMatchObject({ kind: 'tab-slot' })
    // The strip's own chip of the panel floats: the same element, and the only float (no look-alike beside it).
    expect(float()).toBe(chip('p3'))
    expect(container.querySelectorAll('[data-strip-float]')).toHaveLength(1)
    expect(container.querySelector('[data-strip-ghost]')).toBeNull()
    escape()
    untouched(chip('p3'))
  })

  it('a layout handle leaves its group standing over the tree and the dock; over the strip the group is one float', () => {
    registerTree()
    const group = () => container.querySelector<HTMLElement>('[data-layout-group="main"]')!
    press({ kind: 'layout', workspaceId: 'w', host, layoutId: 'main', panelId: 'p1', from: 'sidebar' })
    expect(target()).toMatchObject({ via: 'tree' })
    untouched(group())
    fire(window, 'mousemove', 600, 300)
    expect(target()).toBeNull()
    untouched(group())
    fire(window, 'mousemove', 600, 10)
    expect(target()).toMatchObject({ kind: 'tab-slot' })
    expect(group().style.display).toBe('none')
    expect(container.querySelectorAll('[data-strip-float]')).toHaveLength(1)
    escape()
    untouched(group())
  })
})
