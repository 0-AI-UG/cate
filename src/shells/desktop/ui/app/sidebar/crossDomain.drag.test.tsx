// The 3x3 of the unified drag: the sidebar tree, the window's tab strip and its
// split, each as a source and as a target, mounted together in one window on
// the drag scenario harness (real dispatcher, hit testing over the zones the
// views register, commit), asserting the document each drop produced.

import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { MAIN_WINDOW, canvasOf, dockOf, dockPanels, hostOf, placementOf } from '@workspace/document/contract'
import type { WorkspaceEntry } from '@client/workspaces'
import { add, buildDocument } from '../../../../../test/clientWorkspace'
import { CANVAS_ORDER_KEY } from '../../client/layout/drag'
import { WS, renderScene, type Scene, type SceneSpec } from '../../client/layout/drag/__tests__/harness'
import { installClientApp, type ClientApp } from '../app'
import { WorkspaceRow } from './WorkspaceRow'

const main = { layoutId: 'main' }
const rect = (x: number, y: number, w = 200, h = 150) => ({ origin: { x, y }, size: { width: w, height: h } })
const ENTRY: WorkspaceEntry = { kind: 'local', id: WS, root: '/p', name: WS, lastOpenedAt: 1 }

const domRect = (left: number, top: number, bottom: number) =>
  ({ left, top, right: left + 200, bottom, x: left, y: top, width: 200, height: bottom - top, toJSON: () => ({}) }) as DOMRect
const stub = (el: Element, top: number, bottom: number) =>
  Object.defineProperty(el, 'getBoundingClientRect', { value: () => domRect(0, top, bottom), configurable: true })

/** jsdom has no layout: the tree spans x 0..200, every panel row is 28px with 2px of margin
 *  around it from y 0, so rows (and layouts) touch at 32px. */
function measureTree(root: Element): void {
  let y = 0
  const leaves = new Map<Element, [number, number]>()
  for (const layout of root.querySelectorAll('[data-sb-key^="l:"]')) {
    for (const leaf of layout.querySelectorAll('[data-panel-id]')) { leaves.set(leaf, [y + 2, y + 30]); y += 32 }
  }
  for (const [leaf, [top, bottom]] of leaves) stub(leaf, top, bottom)
  for (const el of root.querySelectorAll('[data-sb-key]')) {
    const inner = [...leaves].filter(([leaf]) => el.contains(leaf)).map(([, span]) => span)
    if (inner.length > 0) stub(el, Math.min(...inner.map((r) => r[0])) - 2, Math.max(...inner.map((r) => r[1])) + 2)
  }
  const group = root.querySelector('[role="group"]')
  if (group) stub(group, 0, 400)
}

/** The workspace's sidebar tree, drawn beside the window. */
const sidebar: SceneSpec['extra'] = {
  node: <WorkspaceRow entry={ENTRY} isOpen isSelected={false} isExpanded onToggleExpand={() => {}} onClick={() => {}} />,
  setup() {
    const state = { kind: 'connected' }
    installClientApp({
      workspaces: { getSnapshot: () => ({ entries: [ENTRY], open: [WS] }), subscribe: () => () => {} } as never,
      connections: { get: () => ({ getState: () => state, subscribe: () => () => {} }) } as unknown as ClientApp['connections'],
      version: 'test',
    })
    return () => installClientApp(null)
  },
  layOut: measureTree,
}

let scene: Scene | null = null
afterEach(() => {
  scene?.unmount()
  scene = null
})

// Cells of the matrix covered elsewhere (docs/dock-rules.md lists every one):
// a row moving inside the tree (WorkspaceRow.drag.test.tsx), a strip chip or
// anchor along the strip (windows/WindowView.drag.test.tsx), a tab or grip
// over the split (drag/__tests__/scenarios.test.tsx).
describe('across the sidebar, the strip and the split', () => {
  // Tree (x 0..200): a 2..30, b 34..62, c 66..94 (layout main), d 98..126 (layout two).
  // Strip (y 0..24): main's anchor 300..324 and chips a, b, c; d 637..737; + at 760.
  // Split (y 30..600): s1 [a, b] at x 300..650, s2 [c] at 650..1000.
  const doc = () => buildDocument([
    add('a', { to: 'stack', dock: main, stackId: 's1' }),
    add('b', { to: 'stack', dock: main, stackId: 's1' }),
    add('c', { to: 'split', dock: main, beside: 's1', side: 'right', stackId: 's2', splitId: 'sp' }),
    { kind: 'addLayout', host: { windowId: MAIN_WINDOW }, layoutId: 'two' },
    add('d', { to: 'stack', dock: { layoutId: 'two' }, stackId: 's3' }),
  ])
  const strip = (y = 0) => ({ y, h: 24 })
  const rects = {
    '[data-window-view]': { x: 300, y: 0, w: 700, h: 600 },
    '[data-window-header]': { x: 300, ...strip(), w: 700 },
    '[data-window-header] [data-layout-group="main"]': { x: 300, ...strip(), w: 327 },
    '[data-window-header] [data-layout-id="main"]': { x: 300, ...strip(), w: 24 },
    '[data-strip-panel-id="a"]': { x: 325, ...strip(), w: 100 },
    '[data-strip-panel-id="b"]': { x: 426, ...strip(), w: 100 },
    '[data-strip-panel-id="c"]': { x: 527, ...strip(), w: 100 },
    '[data-strip-panel-id="d"]': { x: 637, ...strip(), w: 100 },
    '[data-window-header] [aria-label="New tab"]': { x: 760, ...strip(), w: 24 },
  }
  const stacks = { s1: { x: 300, y: 30, w: 350, h: 570 }, s2: { x: 650, y: 30, w: 350, h: 570 } }
  const open = () => { scene = renderScene({ doc: doc(), stacks, rects, window: true, extra: sidebar }) }
  const row = (id: string) => `[data-test-extra] [data-panel-id="${id}"]`
  const handle = '[data-test-extra] [data-layout-gutter="main"]'
  const anchor = '[data-window-header] [data-layout-id="main"]'
  const layouts = () => scene!.doc().windows[MAIN_WINDOW].layouts
  const docks = () => layouts().map((l) => dockPanels(l.dock))
  /** Press, pass the dead zone, then move to `to`. */
  const drag = (selector: string, at: { x: number; y: number } | undefined, to: { x: number; y: number }) => {
    scene!.mouse.downOn(selector, at)
    scene!.mouse.moveBy({ x: 0, y: 5 })
    scene!.mouse.moveTo(to)
  }

  it('sidebar panel row -> split stack tab bar adds it as a tab', () => {
    open()
    drag(row('d'), { x: 50, y: 110 }, { x: 400, y: 40 })
    expect(scene!.drag().source).toMatchObject({ panelId: 'd', from: 'sidebar' })
    expect(scene!.drag().target).toMatchObject({ kind: 'dock-tab', stackId: 's1' })
    scene!.mouse.up()
    expect(placementOf(scene!.doc(), 'd')?.stackId).toBe('s1')
    expect(docks()).toEqual([['a', 'b', 'd', 'c']])
  })

  it('sidebar panel row -> split edge splits beside the stack', () => {
    open()
    drag(row('d'), { x: 50, y: 110 }, { x: 310, y: 300 })
    expect(scene!.drag().target).toMatchObject({ kind: 'dock-split', stackId: 's1', edge: 'left' })
    scene!.mouse.up()
    const tree = dockOf(scene!.doc(), main)
    expect(tree?.kind === 'split' && tree.children.map((c) => dockPanels(c))).toEqual([['d'], ['a', 'b'], ['c']])
    expect(layouts().map((l) => l.id)).toEqual(['main'])
  })

  it('sidebar panel row -> top strip becomes a plain tab at the slot', () => {
    open()
    // b's chip is the ghost, lifted out of the strip: main's group is a and c, d's chip is the last, and the slot is past it.
    drag(row('b'), { x: 50, y: 44 }, { x: 700, y: 10 })
    expect(scene!.drag().target).toMatchObject({ kind: 'tab-slot', index: 2 })
    expect(scene!.drag().target).not.toHaveProperty('via')
    scene!.mouse.up()
    expect(docks()).toEqual([['a', 'c'], ['d'], ['b']])
  })

  it('sidebar panel row -> top strip group makes a pane beside the neighbouring chip', () => {
    open()
    drag(row('d'), { x: 50, y: 110 }, { x: 460, y: 10 })
    expect(scene!.drag().target).toMatchObject({ kind: 'group-slot', layoutId: 'main', beside: 's1', side: 'right' })
    expect(scene!.drag().target).not.toHaveProperty('via')
    scene!.mouse.up()
    expect(docks()).toEqual([['a', 'b', 'd', 'c']])
    expect(placementOf(scene!.doc(), 'd')?.stackId).not.toBe('s1')
  })

  it('sidebar layout handle -> top strip moves the layout', () => {
    open()
    // Past d: the slot after the last tab (main's group stands in the strip; slots count its place).
    drag(handle, { x: 10, y: 40 }, { x: 740, y: 10 })
    expect(scene!.drag().target).toMatchObject({ kind: 'tab-slot', index: 2 })
    expect(scene!.drag().target).not.toHaveProperty('via')
    scene!.mouse.up()
    expect(layouts().map((l) => l.id)).toEqual(['two', 'main'])
  })

  it('sidebar layout handle -> split does nothing', () => {
    open()
    const seq = scene!.workspace.document.seq
    drag(handle, { x: 10, y: 40 }, { x: 400, y: 40 })
    expect(scene!.drag().target).toBeNull()
    scene!.mouse.moveTo({ x: 400, y: 300 })
    expect(scene!.drag().target).toBeNull()
    scene!.mouse.up()
    expect(scene!.workspace.document.seq).toBe(seq)
  })

  it('strip chip -> tree slot places a plain tab between tree items', () => {
    open()
    drag('[data-strip-panel-id="b"]', { x: 470, y: 10 }, { x: 100, y: 85 })
    expect(scene!.drag().target).toMatchObject({ kind: 'tab-slot', index: 1, via: 'tree' })
    scene!.mouse.up()
    expect(docks()).toEqual([['a', 'c'], ['b'], ['d']])
  })

  it('strip chip -> tree group makes a pane beside the neighbouring row\'s stack', () => {
    open()
    drag('[data-strip-panel-id="d"]', { x: 680, y: 10 }, { x: 100, y: 80 })
    expect(scene!.drag().target).toMatchObject({ kind: 'group-slot', layoutId: 'main', via: 'tree' })
    scene!.mouse.up()
    expect(docks()).toEqual([['a', 'b', 'd', 'c']])
    expect(placementOf(scene!.doc(), 'd')?.stackId).not.toBe('s1')
  })

  it('strip chip -> tree between two rows of a stack makes it a tab of that stack', () => {
    open()
    drag('[data-strip-panel-id="d"]', { x: 680, y: 10 }, { x: 100, y: 56 })
    expect(scene!.drag().target).toMatchObject({ kind: 'stack-slot', stackId: 's1', after: 'a' })
    scene!.mouse.up()
    expect(docks()).toEqual([['a', 'd', 'b', 'c']])
    expect(placementOf(scene!.doc(), 'd')?.stackId).toBe('s1')
  })

  it('strip chip -> tree among a canvas\'s children makes it a node there', () => {
    const withCanvas = buildDocument([
      add('cv', { to: 'stack', dock: main, stackId: 's1' }, 'canvas', { canvasId: 'C' }),
      add('n1', { to: 'canvas', canvasId: 'C', nodeId: 'N1', layoutId: 'L-N1', stackId: 'ns1', rect: rect(100, 100) }),
      { kind: 'addLayout', host: { windowId: MAIN_WINDOW }, layoutId: 'two' },
      add('d', { to: 'stack', dock: { layoutId: 'two' }, stackId: 's3' }),
    ])
    scene = renderScene({ doc: withCanvas, rects, window: true, extra: sidebar })
    // Tree: cv 2..30, its child n1 34..62, d 66..94.
    drag('[data-strip-panel-id="d"]', { x: 680, y: 10 }, { x: 100, y: 62 })
    expect(scene.drag().target).toMatchObject({ kind: 'canvas-slot', canvasPanelId: 'cv', after: 'n1' })
    scene.mouse.up()
    expect(canvasOf(scene.doc(), 'd')).toBe('C')
    expect(scene.workspace.state.getSnapshot().panelViews.cv?.[CANVAS_ORDER_KEY]).toEqual(['n1', 'd'])
  })

  it('pane grip -> tree places the panel at the slot', () => {
    open()
    // c's pane (alone in s2) draws a grip, no tab bar.
    drag('[data-pane-drag="c"]', { x: 800, y: 300 }, { x: 100, y: 400 })
    expect(scene!.drag().source?.origin).toMatchObject({ kind: 'dock-tab', stackId: 's2' })
    expect(scene!.drag().target).toMatchObject({ kind: 'tab-slot', index: 2, via: 'tree' })
    scene!.mouse.up()
    expect(docks()).toEqual([['a', 'b'], ['d'], ['c']])
  })

  it('strip layout anchor -> tree moves the layout among the tree\'s items', () => {
    open()
    drag(anchor, { x: 310, y: 10 }, { x: 100, y: 400 })
    expect(scene!.drag().target).toMatchObject({ kind: 'tab-slot', via: 'tree' })
    scene!.mouse.up()
    expect(layouts().map((l) => l.id)).toEqual(['two', 'main'])
    expect(docks()).toEqual([['d'], ['a', 'b', 'c']])
  })

  it('strip layout anchor -> split does nothing', () => {
    open()
    const seq = scene!.workspace.document.seq
    drag(anchor, { x: 310, y: 10 }, { x: 400, y: 40 })
    expect(scene!.drag().target).toBeNull()
    scene!.mouse.moveTo({ x: 800, y: 300 })
    expect(scene!.drag().target).toBeNull()
    scene!.mouse.up()
    expect(scene!.workspace.document.seq).toBe(seq)
  })

  it('a sidebar panel row -> canvas node', () => {
    // Layout main shows canvas C (node n1) in the split; layout two holds d.
    const withCanvas = buildDocument([
      add('cv', { to: 'stack', dock: main, stackId: 's1' }, 'canvas', { canvasId: 'C' }),
      add('n1', { to: 'canvas', canvasId: 'C', nodeId: 'N1', layoutId: 'L-N1', stackId: 'ns1', rect: rect(100, 100) }),
      { kind: 'addLayout', host: { windowId: MAIN_WINDOW }, layoutId: 'two' },
      add('d', { to: 'stack', dock: { layoutId: 'two' }, stackId: 's3' }),
    ])
    scene = renderScene({ doc: withCanvas, rects, window: true, extra: sidebar, canvases: [{ canvasId: 'C', rect: { x: 300, y: 30, w: 700, h: 570 } }] })
    drag(row('d'), undefined, { x: 700, y: 400 })
    expect(scene.drag().source).toMatchObject({ panelId: 'd', from: 'sidebar' })
    expect(scene.drag().target).toMatchObject({ kind: 'canvas-add', canvasId: 'C' })
    scene.mouse.up()
    expect(canvasOf(scene.doc(), 'd')).toBe('C')
    // The node a canvas drop makes: the panel's drop size, not the pressed row's.
    const placed = hostOf(scene.doc(), placementOf(scene.doc(), 'd')!.dock.layoutId)
    const node = placed && 'nodeId' in placed ? scene.doc().canvases.C.nodes[placed.nodeId] : undefined
    expect(node?.rect.size).toEqual({ width: 480, height: 320 })
    expect(layouts().map((l) => l.id)).toEqual(['main'])
  })

  it('a sidebar layout handle -> canvas node: the whole layout becomes the node', () => {
    const withGroup = buildDocument([
      add('cv', { to: 'stack', dock: main, stackId: 's1' }, 'canvas', { canvasId: 'C' }),
      { kind: 'addLayout', host: { windowId: MAIN_WINDOW }, layoutId: 'two' },
      add('d', { to: 'stack', dock: { layoutId: 'two' }, stackId: 's3' }),
      add('e', { to: 'split', dock: { layoutId: 'two' }, beside: 's3', side: 'right', stackId: 's4', splitId: 'sp2' }),
    ])
    scene = renderScene({ doc: withGroup, rects, window: true, extra: sidebar, canvases: [{ canvasId: 'C', rect: { x: 300, y: 30, w: 700, h: 570 } }] })
    drag('[data-test-extra] [data-layout-gutter="two"]', { x: 10, y: 80 }, { x: 700, y: 400 })
    expect(scene.drag().target).toMatchObject({ kind: 'canvas-add', canvasId: 'C' })
    scene.mouse.up()
    expect(canvasOf(scene.doc(), 'd')).toBe('C')
    expect(canvasOf(scene.doc(), 'e')).toBe('C')
    expect(layouts().map((l) => l.id)).toEqual(['main'])
  })

  it('a canvas node -> tree: the node moves out as its layout', () => {
    const withCanvas = buildDocument([
      add('cv', { to: 'stack', dock: main, stackId: 's1' }, 'canvas', { canvasId: 'C' }),
      add('n1', { to: 'canvas', canvasId: 'C', nodeId: 'N1', layoutId: 'L-N1', stackId: 'ns1', rect: rect(100, 100) }),
    ])
    scene = renderScene({ doc: withCanvas, rects, window: true, extra: sidebar, canvases: [{ canvasId: 'C', rect: { x: 300, y: 30, w: 700, h: 570 } }] })
    scene.mouse.downOnNode('N1')
    scene.mouse.dragBy({ x: 30, y: 30 })
    scene.mouse.moveTo({ x: 100, y: 400 })
    expect(scene.drag().target).toMatchObject({ kind: 'tab-slot', via: 'tree' })
    scene.mouse.up()
    expect(canvasOf(scene.doc(), 'n1')).toBeNull()
    expect(layouts().flatMap((l) => dockPanels(l.dock))).toContain('n1')
  })

  it('Escape during a sidebar -> split drag leaves the document unchanged', () => {
    open()
    const seq = scene!.workspace.document.seq
    drag(row('d'), { x: 50, y: 110 }, { x: 400, y: 40 })
    expect(scene!.drag().target).toMatchObject({ kind: 'dock-tab', stackId: 's1' })
    // Mid-drag: the row stands where it is (the tree takes no part), the overlay's chip floats over the split.
    const placeholder = () => document.querySelector('[data-sidebar-drag-ghost], [data-sidebar-drag-float]')
    const chip = () => document.querySelector('[data-drag-overlay-ghost]')
    expect(placeholder()).toBeNull()
    expect(document.querySelector(row('d'))).not.toBeNull()
    expect(chip()).not.toBeNull()
    scene!.mouse.escape()
    expect(scene!.drag().isDragging).toBe(false)
    expect(chip()).toBeNull()
    scene!.mouse.up()
    expect(scene!.workspace.document.seq).toBe(seq)
    expect(placementOf(scene!.doc(), 'd')?.stackId).toBe('s3')
  })

  // One chip per panel in every zone: the zone the drag is over draws the panel's own chip as the ghost
  // (no second, look-alike float), and a zone it is not over leaves its chip standing.
  describe('the panel is one chip', () => {
    const floats = (sel: string) => document.querySelectorAll(sel)

    it('a sidebar row dragged over the strip: the strip\'s chip of the panel floats, nothing else does', () => {
      open()
      drag(row('b'), { x: 50, y: 44 }, { x: 460, y: 10 })
      expect(scene!.drag().target).not.toBeNull()
      expect(floats('[data-window-header] [data-strip-float]')).toHaveLength(1)
      expect(document.querySelector('[data-window-header] [data-strip-float]')).toBe(document.querySelector('[data-strip-panel-id="b"]'))
      expect(floats('[data-strip-ghost]')).toHaveLength(0)
      // The row of the tree is not over the cursor: it stands.
      expect(floats('[data-sidebar-drag-float]')).toHaveLength(0)
      scene!.mouse.escape()
    })

    it('a strip chip dragged over the tree: the tree\'s row of the panel floats, nothing else does', () => {
      open()
      drag('[data-strip-panel-id="b"]', { x: 470, y: 10 }, { x: 100, y: 85 })
      expect(scene!.drag().target).toMatchObject({ via: 'tree' })
      expect(floats('[data-sidebar-drag-float]')).toHaveLength(1)
      expect(document.querySelector('[data-sidebar-drag-float]')).toBe(document.querySelector(row('b')))
      scene!.mouse.escape()
    })

    it('a pane grip dragged over the tree: the tree\'s row of the panel floats', () => {
      open()
      drag('[data-pane-drag="c"]', { x: 800, y: 300 }, { x: 100, y: 85 })
      expect(floats('[data-sidebar-drag-float]')).toHaveLength(1)
      expect(document.querySelector('[data-sidebar-drag-float]')).toBe(document.querySelector(row('c')))
      scene!.mouse.escape()
    })

    it('a sidebar layout handle dragged over the strip: the strip\'s group is replaced by one float', () => {
      open()
      drag(handle, { x: 10, y: 40 }, { x: 740, y: 10 })
      expect(floats('[data-window-header] [data-strip-float]')).toHaveLength(1)
      expect(document.querySelector('[data-layout-group="main"][data-window-header], [data-window-header] [data-layout-group="main"]')).toHaveProperty('style.display', 'none')
      scene!.mouse.escape()
    })
  })
})
