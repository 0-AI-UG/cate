// The workspace tree as a drop zone of the shared drag system: a drag that
// starts anywhere (a strip chip, a pane's grip) resolves to tree targets.
// Rects are stubbed (jsdom has no layout); `resolveDrop` runs against the zones
// the tree registers.

import React, { act, useMemo } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MAIN_WINDOW, hostOf, placementOf, type PanelId } from '@workspace/document/contract'
import { createClientIdentity, installClientIdentity } from '@client/connections'
import { registerPanelDefinitions } from '@client/host'
import type { WorkspaceEntry } from '@client/workspaces'
import { add, attachTestWorkspace, buildDocument, testPanelDefinitions, type TestWorkspace } from '../../../../../test/clientWorkspace'
import { dropChanges, getDropZoneEntries, resetDragDispatch, resetDragRegistry, resolveDrop, useDragStore, type DragSource, type DropTarget } from '../../client/layout/drag'
import { installClientApp, type ClientApp } from '../app'
import { WorkspaceRow } from './WorkspaceRow'
import { workspacePanelTree } from './panelTree'
import { itemKey, layoutKey, layoutRows } from './sidebarDrag'
import { useSidebarTree, type TreeView } from './useSidebarTree'

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
})

afterEach(() => {
  // A drag a test started is cancelled the way the user would.
  act(() => { globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
  resetDragDispatch()
  act(() => root.unmount())
  host.remove()
  ws.detach()
  resetDragRegistry()
  useDragStore.setState({ isDragging: false, target: null, source: null, cursor: null })
  installClientApp(null)
  installClientIdentity(null)
})

const Tree = () => <WorkspaceRow entry={entry} isOpen isSelected={false} isExpanded onToggleExpand={() => {}} onClick={() => {}} />
const rect = (left: number, right: number, top: number, bottom: number) =>
  ({ left, right, top, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect

/** As in WorkspaceRow.drag.test: every panel row is 28px with 2px of margin around it, so rows
 *  (and layouts) touch at 32px; the tree spans x 0..200, y 0..400. */
function measure(labelGap = 0) {
  let y = 0
  const leaves = new Map<Element, [number, number]>()
  for (const layout of host.querySelectorAll('[data-sb-key^="l:"]')) {
    // The "Other windows" label sits above the first layout of another window.
    if (labelGap && (layout as HTMLElement).dataset.sbKey!.includes('W2')) y += labelGap
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

const mountTree = () => { act(() => root.render(<Tree />)); measure() }
const env = { canvasAtCursor: () => null, get dropZones() { return getDropZoneEntries() }, canDetach: () => false }
const cursorAt = (y: number) => ({ client: { x: 100, y }, screen: { x: 100, y }, insideWindow: true })
/** A panel dragged from somewhere else (a strip chip or a pane's grip): a dock tab of its own stack. */
function foreign(panelId: PanelId): DragSource {
  const doc = ws.confirmed()
  const placement = placementOf(doc, panelId)!
  return { workspaceId: 'w', panelId, origin: { kind: 'dock-tab', dock: placement.dock, host: hostOf(doc, placement.dock.layoutId)!, stackId: placement.stackId } }
}
const typeOf = (id: PanelId) => ws.confirmed().panels[id]?.type ?? 'terminal'
const drop = (source: DragSource, y: number) => resolveDrop(cursorAt(y), source, { x: 0, y: 0 }, { width: 100, height: 30 }, typeOf(source.panelId), { env })
const commit = (source: DragSource, target: DropTarget) => {
  const record = ws.confirmed().panels[source.panelId]
  return dropChanges(ws.confirmed(), source, target, { id: record.id, type: record.type, title: record.title }, { newId: () => 'x' })
}

const addCanvas = (...children: string[]) => {
  const size = { width: 100, height: 100 }
  act(() => {
    ws.document.propose(add('cv', { to: 'stack', dock: L1, stackId: 's1' }, 'canvas', { canvasId: 'cvs' }))
    children.forEach((id, i) => ws.document.propose(add(id, { to: 'canvas', canvasId: 'cvs', nodeId: `n${i}`, layoutId: `L-n${i}`, stackId: `ns${i}`, rect: { origin: { x: i * 200, y: 0 }, size } })))
  })
}

describe('the tree as a drop zone', () => {
  // Rows: a 0-32, b 32-64, c 64-96 (group "main"), d 96-128 (layout "two"). A foreign drag's
  // ghost is one row (32px) held by its middle: its top edge is the cursor less 16.
  it('a strip chip over the tree resolves tab-slot with via \'tree\'', () => {
    mountTree()
    expect(drop(foreign('d'), 10)).toEqual({ kind: 'tab-slot', workspaceId: 'w', host: { windowId: MAIN_WINDOW }, index: 0, via: 'tree' })
  })

  it('a panel dock-tab over a group\'s rows resolves group-slot', () => {
    mountTree()
    expect(drop(foreign('d'), 80)).toEqual({ kind: 'group-slot', workspaceId: 'w', layoutId: 'main', beside: 's1', side: 'right', slot: 2, via: 'tree' })
  })

  it('over a canvas\'s children resolves canvas-slot with order', () => {
    addCanvas('t')
    mountTree()
    // Rows: a, b, cv 64-96 (with its child t 96-128), c, d. The slot before t is at 96.
    expect(drop(foreign('d'), 112)).toEqual({ kind: 'canvas-slot', workspaceId: 'w', canvasPanelId: 'cv', after: null, order: ['d', 't'] })
  })

  it('an empty canvas (no kids) still takes canvas-slot', () => {
    addCanvas()
    mountTree()
    // cv 64-96: its slot sits 8px inside its bottom edge.
    expect(drop(foreign('d'), 104)).toEqual({ kind: 'canvas-slot', workspaceId: 'w', canvasPanelId: 'cv', after: null, order: ['d'] })
  })

  it('with two windows the nearer window\'s host is used', () => {
    act(() => { ws.document.propose(add('e', { to: 'window', windowId: 'W2', layoutId: 'W2-main', stackId: 'ws2' })) })
    mountTree()
    // Window W2's row e is 128-160, below the main window's rows; a's row is lifted, so e moves up to 96-128.
    expect(drop(foreign('a'), 116)).toMatchObject({ kind: 'tab-slot', host: { windowId: 'W2' }, index: 0, via: 'tree' })
    expect(drop(foreign('b'), 10)).toMatchObject({ kind: 'tab-slot', host: { windowId: MAIN_WINDOW }, index: 0, via: 'tree' })
  })

  it('the room between the main window\'s last row and the next window\'s first is not claimed by either, going down or up', () => {
    act(() => { ws.document.propose(add('e', { to: 'window', windowId: 'W2', layoutId: 'W2-main', stackId: 'ws2' })) })
    act(() => root.render(<Tree />))
    measure(24)
    // Main's rows end at 128 (96 with the dragged row gone); the label takes 128..152, W2's row follows.
    const source = foreign('a')
    const where = (y: number) => { const t = drop(source, y) as { host?: { windowId: string }; index?: number }; return `${t.host?.windowId}:${t.index}` }
    const down = Array.from({ length: 30 }, (_, i) => where(80 + i * 4))
    const up = Array.from({ length: 30 }, (_, i) => where(196 - i * 4)).reverse()
    for (const sweep of [down, up]) {
      // main's end slot holds for a stretch of the label's height, then the next window's first slot takes over
      expect(sweep.filter((w) => w === `${MAIN_WINDOW}:2`).length).toBeGreaterThanOrEqual(3)
      expect(sweep.indexOf('W2:0')).toBeGreaterThan(sweep.lastIndexOf(`${MAIN_WINDOW}:2`))
    }
  })

  it('a foreign panel over its own row resolves a no-op target (commit returns null)', () => {
    mountTree()
    // b's row is lifted: at its own spot in the group, nothing drops.
    const b = foreign('b')
    const own = drop(b, 48)
    expect(own).toMatchObject({ kind: 'group-home', layoutId: 'main', via: 'tree' })
    expect(commit(b, own!)).toBeNull()
    // d before its own layout: the plain tab stays where it is.
    const d = foreign('d')
    const home = drop(d, 112)
    expect(home).toMatchObject({ kind: 'tab-slot', index: 1, via: 'tree' })
    expect(commit(d, home!)).toBeNull()
  })

  it('canvas-node drags are accepted and produce tree targets; remote drags resolve nothing', () => {
    addCanvas('t', 'u')
    mountTree()
    const node: DragSource = { workspaceId: 'w', panelId: 't', origin: { kind: 'canvas-node', canvasId: 'cvs', nodeId: 'n0' } }
    const remote: DragSource = {
      workspaceId: 'w',
      panelId: 'd',
      origin: { kind: 'remote', drag: { dragId: 'x', workspaceId: 'w', panelId: 'd', panelType: 'terminal', title: 'd', size: { width: 480, height: 320 }, grab: { x: 0, y: 0 } } },
    }
    // Canvas-node sources resolve to tree targets (stack-slot, tab-slot, or group-slot)
    // All should be valid tree targets with a workspaceId
    for (const y of [10, 80, 112, 140]) {
      const target = drop(node, y)!
      expect(target).toBeDefined()
      expect(['stack-slot', 'tab-slot', 'group-slot', 'group-home']).toContain(target.kind)
      expect(target).toHaveProperty('workspaceId', 'w')
    }
    // Remote drags still resolve nothing
    for (const y of [10, 80, 112, 140]) {
      expect(drop(remote, y)).toBeNull()
    }
  })

  it('a dock tab over a canvas\'s children takes the canvas slot and draws its container; a canvas node drops into tree slots (no container shown)', () => {
    addCanvas('t')
    mountTree()
    const container = () => host.querySelector('[data-canvas-container="cv"]')
    const d = foreign('d')
    const target = drop(d, 112)!
    expect(target).toMatchObject({ kind: 'canvas-slot', canvasPanelId: 'cv' })
    act(() => useDragStore.setState({ isDragging: true, source: d, target, cursor: cursorAt(112) }))
    expect(container()).not.toBeNull()
    expect(host.querySelector('[data-canvas-end]')).not.toBeNull()
    // A canvas-node resolves to tree targets, not canvas-slot, so no container is shown.
    const node: DragSource = { workspaceId: 'w', panelId: 't', origin: { kind: 'canvas-node', canvasId: 'cvs', nodeId: 'n0' } }
    const nodeTarget = drop(node, 112)!
    expect(nodeTarget).toMatchObject({ kind: expect.stringMatching(/tab-slot|group-slot/), via: 'tree' })
    act(() => useDragStore.setState({ source: node, target: nodeTarget }))
    expect(container()).toBeNull()
  })

  it('a group node (a layout of 2+ panels) takes tab slots only, like a layout', () => {
    addCanvas('t')
    act(() => { ws.document.propose(add('u', { to: 'stack', dock: { layoutId: 'L-n0' }, stackId: 'ns0' })) })
    mountTree()
    const node: DragSource = { workspaceId: 'w', panelId: 't', origin: { kind: 'canvas-node', canvasId: 'cvs', nodeId: 'n0' } }
    const groupEnv = { ...env, nodeIsGroup: (_w: string, _c: string, n: string) => n === 'n0' }
    for (const y of [10, 80, 112, 140]) {
      expect(resolveDrop(cursorAt(y), node, { x: 0, y: 0 }, { width: 100, height: 30 }, typeOf('t'), { env: groupEnv }))
        .toMatchObject({ kind: 'tab-slot', workspaceId: 'w', via: 'tree' })
    }
  })

  it('a group node, as tall as the group it becomes, still reaches the last slot at the foot of the tree', () => {
    addCanvas('t')
    act(() => {
      ws.document.propose(add('u', { to: 'stack', dock: { layoutId: 'L-n0' }, stackId: 'ns0' }))
      ws.document.propose(add('v', { to: 'split', dock: { layoutId: 'L-n0' }, beside: 'ns0', side: 'right', stackId: 'ns1b', splitId: 'spn' }))
    })
    mountTree()
    const layouts = ws.confirmed().windows[MAIN_WINDOW].layouts.length
    const node: DragSource = { workspaceId: 'w', panelId: 't', origin: { kind: 'canvas-node', canvasId: 'cvs', nodeId: 'n0' } }
    const groupEnv = { ...env, nodeIsGroup: () => true }
    for (const y of [100, 130, 160, 200, 230, 260, 300, 395]) console.log('DBG', y, JSON.stringify(resolveDrop(cursorAt(y), node, { x: 0, y: 0 }, { width: 100, height: 30 }, typeOf('t'), { env: groupEnv })), JSON.stringify(drop(foreign('d'), y)))
    // The rows end near 260 (the canvas row, its three nodes, four more panels, 32px each); the zone runs to 400.
    for (const y of [300, 350, 395]) {
      expect(resolveDrop(cursorAt(y), node, { x: 0, y: 0 }, { width: 100, height: 30 }, typeOf('t'), { env: groupEnv }))
        .toMatchObject({ kind: 'tab-slot', index: layouts })
    }
  })

  it('a layout dragged from the strip takes tab slots only', () => {
    mountTree()
    const source: DragSource = { workspaceId: 'w', panelId: 'd', origin: { kind: 'layout', host: { windowId: MAIN_WINDOW }, layoutId: 'two' } }
    expect(drop(source, 80)).toMatchObject({ kind: 'tab-slot', index: 1, via: 'tree' })
  })
})

// The hook on its own: rows drawn plainly, the view read from the drag store.
let view: TreeView | null = null
let renders = 0
function Probe() {
  renders++
  const doc = ws.confirmed()
  const tree = useMemo(() => workspacePanelTree(doc, { windowId: MAIN_WINDOW }), [doc])
  const { containerRef, view: v } = useSidebarTree('w', [tree.primary])
  view = v
  return (
    <div ref={containerRef} role="group">
      {tree.primary.layouts.map((l) => (
        <div key={l.layoutId} data-sb-key={layoutKey(MAIN_WINDOW, l.layoutId)}>
          {layoutRows(l).map((r) => <div key={r.record.id} data-sb-key={itemKey(r.record.id)}><div data-panel-id={r.record.id} /></div>)}
        </div>
      ))}
    </div>
  )
}

describe('useSidebarTree view', () => {
  it('is the tree\'s target with its gap while a drag over the tree runs; null otherwise', () => {
    act(() => root.render(<Probe />))
    measure()
    expect(view).toBeNull()
    const source = foreign('d')
    const target = drop(source, 80)!
    act(() => useDragStore.setState({ isDragging: true, source, target, cursor: cursorAt(80) }))
    expect(view).toMatchObject({ target, gap: { at: 'member', layoutId: 'main', panelId: 'c' }, size: 32 })
    expect(view!.float.top).toBe(80 - 16 + 2)
    // Over another zone (a split's stack) the tree shows nothing.
    act(() => useDragStore.setState({ target: { kind: 'dock-tab', workspaceId: 'w', dock: L1, stackId: 's2' } }))
    expect(view).toBeNull()
    act(() => useDragStore.setState({ target, isDragging: false }))
    expect(view).toBeNull()
  })

  it('a drag the tree does not resolve does not re-render it as the cursor moves', () => {
    act(() => root.render(<Probe />))
    measure()
    renders = 0
    // A canvas node dragged over a split's stack.
    const source: DragSource = { workspaceId: 'w', panelId: 'a', origin: { kind: 'canvas-node', canvasId: 'cvs', nodeId: 'n0' } }
    act(() => useDragStore.setState({ isDragging: true, source, target: { kind: 'dock-tab', workspaceId: 'w', dock: L1, stackId: 's2' }, cursor: cursorAt(10) }))
    for (const y of [20, 30, 40]) act(() => useDragStore.setState({ cursor: cursorAt(y) }))
    expect(renders).toBe(0)
    // A tree target of another drag than the one the tree last resolved is not this tree's.
    const other = foreign('d')
    const target = drop(other, 80)!
    act(() => useDragStore.setState({ source, target }))
    expect(renders).toBe(0)
    expect(view).toBeNull()
    // Over the tree it follows the cursor.
    act(() => useDragStore.setState({ source: other, target, cursor: cursorAt(80) }))
    expect(renders).toBe(1)
    drop(other, 90)
    act(() => useDragStore.setState({ cursor: cursorAt(90) }))
    expect(renders).toBe(2)
    expect(view!.float.top).toBe(90 - 16 + 2)
  })
})

describe('drags that began on the tree (from \'sidebar\')', () => {
  const own = (source: DragSource): DragSource => ({ ...source, from: 'sidebar' })

  it('a panel row lifts itself: the rows below move up into its room', () => {
    mountTree()
    const a = own(foreign('a'))
    expect(drop(a, 16)).toMatchObject({ kind: 'tab-slot', index: 0 })
    // Pressed at 16, at 44 its top edge (28) is past b, which moved up to 0-32: a pane beside b's stack.
    expect(drop(a, 44)).toEqual({ kind: 'group-slot', workspaceId: 'w', layoutId: 'main', beside: 's1', side: 'right', slot: 1, via: 'tree' })
    // Dragged from elsewhere it lifts its row the same, held by its middle: a pane beside b's stack again.
    expect(drop(foreign('a'), 48)).toMatchObject({ kind: 'group-slot', layoutId: 'main', beside: 's1', side: 'right', via: 'tree' })
  })

  it('a canvas child lifts itself out of its canvas\'s list', () => {
    addCanvas('t', 'u')
    mountTree()
    // Rows: a, b, cv 64-96 with t 96-128 and u 128-160, c, d.
    const t = own(foreign('t'))
    expect(drop(t, 112)).toMatchObject({ kind: 'canvas-slot', canvasPanelId: 'cv', after: null, order: ['t', 'u'] })
    expect(drop(t, 140)).toEqual({ kind: 'canvas-slot', workspaceId: 'w', canvasPanelId: 'cv', after: 'u', order: ['u', 't'] })
    expect(drop(t, 40)).toEqual({ kind: 'stack-slot', workspaceId: 'w', layoutId: 'main', stackId: 's1', after: 'a' })
  })

  it('a layout handle lifts the whole group and takes tab slots only', () => {
    mountTree()
    const main: DragSource = { workspaceId: 'w', panelId: 'a', from: 'sidebar', origin: { kind: 'layout', host: { windowId: MAIN_WINDOW }, layoutId: 'main' } }
    expect(drop(main, 40)).toMatchObject({ kind: 'tab-slot', index: 0, via: 'tree' })
    expect(drop(main, 80)).toEqual({ kind: 'tab-slot', workspaceId: 'w', host: { windowId: MAIN_WINDOW }, index: 2, via: 'tree' })
  })

  it('a drag from elsewhere reaches the slot after the last layout (the walls make room past the last row)', () => {
    mountTree()
    // d's own layout is lifted with its row: the slot past the last one standing is index 1.
    expect(drop(foreign('d'), 400)).toMatchObject({ kind: 'tab-slot', index: 1, via: 'tree' })
  })

  it('a press on a row starts a sidebar drag measured on the row, not on its canvas node', () => {
    addCanvas('t')
    mountTree()
    // The canvas node's element, far bigger than the row: a dock tab of a node measures against it, a row must not.
    const node = document.createElement('div')
    node.dataset.nodeId = 'n0'
    node.getBoundingClientRect = () => rect(400, 900, 0, 300)
    document.body.append(node)
    const row = host.querySelector<HTMLElement>('[data-panel-id="t"]')!
    const top = row.getBoundingClientRect().top
    const fire = (target: EventTarget, type: string, y: number) =>
      act(() => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: 50, clientY: y, button: 0 })) })
    fire(row, 'mousedown', top + 5)
    fire(globalThis, 'mousemove', top + 15)
    const drag = useDragStore.getState()
    expect(drag.source).toMatchObject({ workspaceId: 'w', panelId: 't', from: 'sidebar', origin: { kind: 'dock-tab', host: { nodeId: 'n0' }, stackId: 'ns0' } })
    // The ghost previews the node a canvas drop makes (the tree reads only the row-relative grab).
    expect(drag.ghostSize).toEqual({ width: 480, height: 320 })
    expect(drag.grab).toEqual({ x: 50, y: 5 })
    node.remove()
  })

  it('a pressed row floats over the tree at its row\'s size, not the canvas-drop size', () => {
    mountTree()
    const row = host.querySelector<HTMLElement>('[data-panel-id="d"]')!
    const fire = (target: EventTarget, type: string, y: number) =>
      act(() => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: 50, clientY: y, button: 0 })) })
    // d is 98..126: pressed 10px into it, dragged up over b.
    fire(row, 'mousedown', 108)
    fire(globalThis, 'mousemove', 60)
    expect(useDragStore.getState().target).toMatchObject({ kind: 'stack-slot' })
    const float = host.querySelector<HTMLElement>('[data-sidebar-drag-float]')!
    expect(float.dataset.panelId).toBe('d')
    expect(float.style.height).toBe('28px')
    expect(float.style.width).toBe('200px')
  })
})
