import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MAIN_WINDOW, dockPanels } from '@workspace/document/contract'
import { createClientIdentity, installClientIdentity } from '@client/connections'
import { registerPanelDefinitions } from '@client/host'
import type { WorkspaceEntry } from '@client/workspaces'
import { add, attachTestWorkspace, buildDocument, testPanelDefinitions, type TestWorkspace } from '../../../../../test/clientWorkspace'
import { installClientApp, type ClientApp } from '../app'
import { WorkspaceRow } from './WorkspaceRow'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
beforeAll(() => registerPanelDefinitions(testPanelDefinitions()))

const entry: WorkspaceEntry = { kind: 'local', id: 'w', root: '/p', name: 'w', lastOpenedAt: 1 }
const L1 = { windowId: MAIN_WINDOW, layoutId: 'main' }
const L2 = { windowId: MAIN_WINDOW, layoutId: 'two' }
const state = { kind: 'connected' }
const connected = { getState: () => state, subscribe: () => () => {} }

let ws: TestWorkspace
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  installClientIdentity(createClientIdentity({ device: { name: 'd', keyFingerprint: 'FP' }, features: [] }))
  installClientApp({
    workspaces: { getSnapshot: () => ({ entries: [entry], open: ['w'] }), subscribe: () => () => {} } as never,
    connections: { get: () => connected } as unknown as ClientApp['connections'],
    version: '2.1.0',
  })
  // Layout "main": stack s1 [a, b] beside stack s2 [c]; layout "two": [d].
  ws = attachTestWorkspace('w', buildDocument([
    add('a', { to: 'stack', dock: L1, stackId: 's1' }),
    add('b', { to: 'stack', dock: L1, stackId: 's1' }),
    add('c', { to: 'split', dock: L1, beside: 's1', side: 'right', stackId: 's2', splitId: 'sp' }),
    { kind: 'addLayout', windowId: MAIN_WINDOW, layoutId: 'two', name: 'Two' },
    add('d', { to: 'stack', dock: L2, stackId: 's3' }),
  ]))
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(<WorkspaceRow entry={entry} isOpen isSelected={false} isExpanded onToggleExpand={() => {}} onClick={() => {}} />))
  // jsdom has no layout: leaf rows stack at 30px steps (8px more between splits),
  // a layout's rect spans its rows, the tree spans x 0..200.
  let y = 0
  let lastStack: Element | null = null
  const spans = new Map<HTMLElement, [number, number]>()
  const anchors = [...host.querySelectorAll<HTMLElement>('[data-sb-key]')]
  for (const el of anchors.filter((a) => !a.querySelector('[data-sb-key]'))) {
    const stack = el.closest('[data-sb-stack]')
    if (stack && lastStack && stack !== lastStack) y += 8
    if (stack) lastStack = stack
    spans.set(el, [y, y + 28])
    y += 30
  }
  for (const el of anchors) {
    const inner = [...spans].filter(([leaf]) => el === leaf || el.contains(leaf)).map(([, span]) => span)
    el.getBoundingClientRect = () => rect(0, 200, Math.min(...inner.map((r) => r[0])), Math.max(...inner.map((r) => r[1])))
  }
  const group = host.querySelector<HTMLElement>('[role="group"]')!
  group.getBoundingClientRect = () => rect(0, 200, 0, 400)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  ws.detach()
  installClientApp(null)
  installClientIdentity(null)
})

const rect = (left: number, right: number, top: number, bottom: number) =>
  ({ left, right, top, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect
const fire = (target: EventTarget, type: string, x: number, y: number) =>
  act(() => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 })) })
const keyOf = (key: string) => host.querySelector<HTMLElement>(`[data-sb-key="${key}"]`)!
const rowOf = (id: string) => host.querySelector<HTMLElement>(`[data-panel-id="${id}"]`)!
const order = () => [...host.querySelectorAll('[data-panel-id]')].map((el) => (el as HTMLElement).dataset.panelId)
const layoutIds = () => ws.confirmed().windows[MAIN_WINDOW].layouts.map((l) => l.id)

describe('the workspace tree', () => {
  it('headings sit at the root; their rows are indented and splits are spaced apart', () => {
    expect(layoutIds()).toEqual(['main', 'two'])
    expect([...host.querySelectorAll('[data-layout-heading]')].map((h) => (h as HTMLElement).dataset.layoutHeading)).toEqual(['main', 'two'])
    expect(rowOf('a').style.paddingLeft).toBe('44px')
    expect([...host.querySelectorAll('[data-sb-stack]')].map((s) => s.className)).toEqual(['', 'relative mt-2', ''])
    expect(order()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('a panel row dragged to another split lands there; the ghost marks the slot and the row leaves the list', () => {
    const before = rowOf('a')
    fire(before, 'pointerdown', 50, 40)
    // Past the threshold, just under c's row: after c in its own stack.
    fire(globalThis, 'pointermove', 50, 124)
    expect(host.querySelector('[data-sidebar-drag-ghost]')).not.toBeNull()
    expect(host.querySelector('[data-sidebar-drag-float]') ?? document.querySelector('[data-sidebar-drag-float]')).not.toBeNull()
    expect(order()).toEqual(['b', 'c', 'd'])
    fire(globalThis, 'pointerup', 50, 124)
    const doc = ws.confirmed()
    expect(dockPanels(doc.windows[MAIN_WINDOW].layouts[0].dock)).toEqual(['b', 'c', 'a'])
    expect(host.querySelector('[data-sidebar-drag-ghost]')).toBeNull()
  })

  it('a hairline divides the splits only while a panel row is dragged', () => {
    expect(host.querySelector('[data-split-divider]')).toBeNull()
    fire(rowOf('a'), 'pointerdown', 50, 40)
    fire(globalThis, 'pointermove', 50, 124)
    expect(host.querySelectorAll('[data-split-divider]')).toHaveLength(1)
    fire(globalThis, 'pointerup', 50, 124)
    expect(host.querySelector('[data-split-divider]')).toBeNull()
    // A layout drag has no use for it.
    fire(host.querySelector('[data-layout-heading="main"]')!, 'pointerdown', 50, 5)
    fire(globalThis, 'pointermove', 50, 200)
    expect(host.querySelector('[data-split-divider]')).toBeNull()
    fire(globalThis, 'pointerup', 50, 5)
  })

  it('a panel row dragged onto another layout moves it there', () => {
    fire(rowOf('c'), 'pointerdown', 50, 100)
    // Below d, the last row of the second layout.
    fire(globalThis, 'pointermove', 50, 200)
    fire(globalThis, 'pointerup', 50, 200)
    const layouts = ws.confirmed().windows[MAIN_WINDOW].layouts
    expect(dockPanels(layouts[1].dock)).toContain('c')
    expect(dockPanels(layouts[0].dock)).not.toContain('c')
  })

  it('dragging a layout heading reorders the layouts; a click without travel still switches', () => {
    const heading = host.querySelector<HTMLElement>('[data-layout-heading="main"]')!
    fire(heading, 'pointerdown', 50, 5)
    fire(globalThis, 'pointermove', 50, 200)
    expect(host.querySelector('[data-sidebar-drag-ghost]')).not.toBeNull()
    fire(globalThis, 'pointerup', 50, 200)
    expect(layoutIds()).toEqual(['two', 'main'])

    const seq = ws.document.getSnapshot()
    const two = host.querySelector<HTMLElement>('[data-layout-heading="two"]')!
    fire(two, 'pointerdown', 50, 5)
    fire(globalThis, 'pointerup', 50, 5)
    expect(ws.document.getSnapshot()).toBe(seq)
  })

  it('a panel alone in its layout dropped back on its own layout leaves no ghost behind', () => {
    const seq = ws.document.getSnapshot()
    fire(rowOf('d'), 'pointerdown', 50, 160)
    fire(globalThis, 'pointermove', 50, 170)
    expect(host.querySelectorAll('[data-sidebar-drag-ghost]')).toHaveLength(1)
    fire(globalThis, 'pointermove', 50, 175)
    expect(host.querySelectorAll('[data-sidebar-drag-ghost]')).toHaveLength(1)
    fire(globalThis, 'pointerup', 50, 175)
    expect(ws.document.getSnapshot()).toBe(seq)
    expect(host.querySelectorAll('[data-sidebar-drag-ghost]')).toHaveLength(0)
    expect(document.querySelectorAll('[data-sidebar-drag-float]')).toHaveLength(0)
    expect(order()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('a drop outside the tree changes nothing', () => {
    const seq = ws.document.getSnapshot()
    fire(rowOf('a'), 'pointerdown', 50, 35)
    fire(globalThis, 'pointermove', 500, 35)
    fire(globalThis, 'pointerup', 500, 35)
    expect(ws.document.getSnapshot()).toBe(seq)
    expect(keyOf('a')).not.toBeNull()
  })
})
