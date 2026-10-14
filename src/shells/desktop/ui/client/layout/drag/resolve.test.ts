import { beforeAll, describe, expect, it } from 'vitest'
import { MAIN_WINDOW, type DockRef } from '@workspace/document/contract'
import { registerPanelDefinitions } from '@client/host'
import { testPanelDefinitions } from '../../../../../../test/clientWorkspace'
import { resolveDrop, type CanvasHit, type DropEnvironment } from './resolve'
import { resolveDropEdge, type DropZoneEntry } from './registry'
import type { DragSource } from './types'

beforeAll(() => registerPanelDefinitions(testPanelDefinitions()))

const main: DockRef = { layoutId: 'main' }
const rect = (x: number, y: number, w: number, h: number) => new DOMRectShim(x, y, w, h) as unknown as DOMRect

class DOMRectShim {
  constructor(public x: number, public y: number, public width: number, public height: number) {}
  get left() { return this.x }
  get top() { return this.y }
  get right() { return this.x + this.width }
  get bottom() { return this.y + this.height }
}

function stackEntry(stackId: string, r: DOMRect, extra: Partial<DropZoneEntry> = {}): DropZoneEntry {
  return { id: stackId, workspaceId: 'ws', dock: main, host: { windowId: 'main' }, stackId, getRect: () => r, tabCount: () => 2, ...extra }
}

function env(dropZones: DropZoneEntry[], canvas: CanvasHit | null = null, canDetach = true): DropEnvironment {
  return { dropZones, canvasAtCursor: () => canvas, canDetach: () => canDetach }
}

const cursor = (x: number, y: number, insideWindow = true) => ({ client: { x, y }, screen: { x: x + 1000, y: y + 1000 }, insideWindow })
const tabSource = (stackId = 'other'): DragSource => ({ workspaceId: 'ws', panelId: 'p', origin: { kind: 'dock-tab', host: { windowId: 'main' }, dock: main, stackId } })
const nodeSource = (extra: object = {}): DragSource => ({ workspaceId: 'ws', panelId: 'p', origin: { kind: 'canvas-node', canvasId: 'C', nodeId: 'N1', ...extra } })
const grab = { x: 10, y: 10 }
const size = { width: 200, height: 100 }
const canvasHit: CanvasHit = { workspaceId: 'ws', canvasId: 'C', rect: { left: 0, top: 0 }, viewport: { offset: { x: 0, y: 0 }, zoom: 1 } }

describe('resolveDropEdge', () => {
  const r = rect(0, 0, 400, 400)
  it('the tab bar strip is center', () => expect(resolveDropEdge(200, 10, r)).toBe('center'))
  it('edge bands', () => {
    expect(resolveDropEdge(200, 40, r)).toBe('top')
    expect(resolveDropEdge(200, 395, r)).toBe('bottom')
    expect(resolveDropEdge(5, 200, r)).toBe('left')
    expect(resolveDropEdge(395, 200, r)).toBe('right')
  })
  it('the body is nothing', () => expect(resolveDropEdge(200, 200, r)).toBeNull())
})

describe('resolveDrop', () => {
  it('outside the window detaches, only where windows can open', () => {
    expect(resolveDrop(cursor(-5, 10, false), tabSource(), grab, size, 'terminal', { env: env([]) })).toEqual({ kind: 'detach', screen: { x: 995, y: 1010 } })
    expect(resolveDrop(cursor(-5, 10, false), tabSource(), grab, size, 'terminal', { env: env([], null, false) })).toBeNull()
  })

  it('stack tab bar, edges and body', () => {
    const e = env([stackEntry('s1', rect(0, 0, 400, 400))])
    expect(resolveDrop(cursor(200, 10), tabSource(), grab, size, 'terminal', { env: e })).toMatchObject({ kind: 'dock-tab', stackId: 's1' })
    expect(resolveDrop(cursor(200, 40), tabSource(), grab, size, 'terminal', { env: e })).toMatchObject({ kind: 'dock-split', edge: 'top' })
    expect(resolveDrop(cursor(5, 200), tabSource(), grab, size, 'terminal', { env: e })).toMatchObject({ kind: 'dock-split', edge: 'left' })
    expect(resolveDrop(cursor(200, 200), tabSource(), grab, size, 'terminal', { env: e })).toBeNull()
  })

  it('the tightest stack wins, stacks before whole docks and edge strips', () => {
    const e = env([
      { id: 'dock', workspaceId: 'ws', dock: main, host: { windowId: 'main' }, getRect: () => rect(0, 0, 1000, 1000) },
      stackEntry('big', rect(0, 0, 800, 800)),
      stackEntry('small', rect(100, 0, 200, 200)),
    ])
    expect(resolveDrop(cursor(150, 10), tabSource(), grab, size, 'terminal', { env: e })).toMatchObject({ kind: 'dock-tab', stackId: 'small' })
  })

  it('a lone tab over its own stack: tab bar previews, edges do nothing', () => {
    const e = env([stackEntry('s1', rect(0, 0, 400, 400), { tabCount: () => 1 })])
    expect(resolveDrop(cursor(200, 10), tabSource('s1'), grab, size, 'terminal', { env: e })).toMatchObject({ kind: 'dock-tab', stackId: 's1' })
    expect(resolveDrop(cursor(395, 200), tabSource('s1'), grab, size, 'terminal', { env: e })).toBeNull()
  })

  it('several tabs over their own stack may split it', () => {
    const e = env([stackEntry('s1', rect(0, 0, 400, 400))])
    expect(resolveDrop(cursor(395, 200), tabSource('s1'), grab, size, 'terminal', { env: e })).toMatchObject({ kind: 'dock-split', edge: 'right' })
  })

  it('a canvas panel skips node docks and canvases', () => {
    const nodeDock = stackEntry('ns', rect(0, 0, 400, 400), { dock: { layoutId: 'L-N9' }, host: { canvasId: 'C', nodeId: 'N9' } })
    expect(resolveDrop(cursor(200, 10), tabSource(), grab, size, 'canvas', { env: env([nodeDock], canvasHit) })).toBeNull()
  })

  it('a dragged node never drops into its own mini dock', () => {
    const own = stackEntry('ns1', rect(0, 0, 400, 400), { dock: { layoutId: 'L-N1' }, host: { canvasId: 'C', nodeId: 'N1' } })
    expect(resolveDrop(cursor(200, 10), nodeSource(), grab, size, 'terminal', { env: env([own], canvasHit) })).toMatchObject({ kind: 'canvas-reposition' })
  })

  it('another workspace is never a target', () => {
    const e = env([stackEntry('s1', rect(0, 0, 400, 400), { workspaceId: 'other' })], { ...canvasHit, workspaceId: 'other' })
    expect(resolveDrop(cursor(200, 10), tabSource(), grab, size, 'terminal', { env: e })).toBeNull()
  })

  it('canvas: the same canvas repositions, anything else adds, with zoom and offset applied', () => {
    const hit: CanvasHit = { ...canvasHit, rect: { left: 100, top: 50 }, viewport: { offset: { x: 20, y: 10 }, zoom: 2 } }
    const moved = resolveDrop(cursor(300, 250), nodeSource(), grab, size, 'terminal', { env: env([], hit) })
    // canvas point = ((300-100-20)/2, (250-50-10)/2) = (90, 95), minus grab.
    expect(moved).toMatchObject({ kind: 'canvas-reposition', nodeId: 'N1', origin: { x: 80, y: 85 }, zoom: 2 })
    expect(resolveDrop(cursor(300, 250), tabSource(), grab, size, 'terminal', { env: env([], hit) })).toMatchObject({ kind: 'canvas-add', size })
    const fromNodeDock: DragSource = { workspaceId: 'ws', panelId: 'p', origin: { kind: 'dock-tab', host: { canvasId: 'C', nodeId: 'N1' }, dock: { layoutId: 'L-N1' }, stackId: 'ns1' } }
    expect(resolveDrop(cursor(300, 250), fromNodeDock, grab, size, 'terminal', { env: env([], hit) })).toMatchObject({ kind: 'canvas-add' })
  })

  it('snap puts the origin on the grid and previews the cell', () => {
    const target = resolveDrop(cursor(137, 93), nodeSource(), grab, size, 'terminal', { env: env([], canvasHit), snap: true })
    expect(target).toMatchObject({ kind: 'canvas-reposition', origin: { x: 120, y: 80 }, ghostRect: { left: 120, top: 80, width: 200, height: 100 } })
    const raw = resolveDrop(cursor(137, 93), nodeSource(), grab, size, 'terminal', { env: env([], canvasHit) })
    expect(raw).toMatchObject({ origin: { x: 127, y: 83 } })
  })

  it('a group only moves on its own canvas', () => {
    const group = nodeSource({ startOrigin: { x: 0, y: 0 }, members: [{ nodeId: 'N2', startOrigin: { x: 500, y: 0 } }] })
    const e = env([stackEntry('s1', rect(0, 0, 400, 400))], canvasHit)
    expect(resolveDrop(cursor(200, 10), group, grab, size, 'terminal', { env: e })).toMatchObject({ kind: 'canvas-reposition' })
    expect(resolveDrop(cursor(-5, 10, false), group, grab, size, 'terminal', { env: e })).toBeNull()
    expect(resolveDrop(cursor(200, 10), group, grab, size, 'terminal', { env: env([], { ...canvasHit, canvasId: 'D' }) })).toBeNull()
  })
})

describe('resolveDrop on a tab strip', () => {
  const host = { windowId: 'main' }
  // The strip picks its own drop (its model keeps the drag's state): here a fake.
  const seen: Array<{ x: number; origin: string }> = []
  const zone: DropZoneEntry = {
    id: 'strip', workspaceId: 'ws', dock: { layoutId: '' }, host, getRect: () => rect(0, 0, 600, 40),
    strip: { resolve: (x, source) => { seen.push({ x, origin: source.origin.kind }); return x < 300 ? { kind: 'tab-slot', index: 1 } : x < 400 ? { kind: 'group-slot', layoutId: 'g', beside: 'sa', side: 'right', slot: 1 } : { kind: 'group-home', layoutId: 'g', slot: 0 } } },
  }
  const over = (x: number, source: DragSource = tabSource()) => resolveDrop(cursor(x, 10), source, grab, size, 'terminal', { env: env([zone]) })

  it('asks the strip and adds the workspace (and the host for a tab slot)', () => {
    expect(over(100)).toEqual({ kind: 'tab-slot', workspaceId: 'ws', host, index: 1 })
    expect(over(350)).toEqual({ kind: 'group-slot', workspaceId: 'ws', layoutId: 'g', beside: 'sa', side: 'right', slot: 1 })
    expect(over(500)).toEqual({ kind: 'group-home', workspaceId: 'ws', layoutId: 'g', slot: 0 })
    expect(seen.at(-1)).toEqual({ x: 500, origin: 'dock-tab' })
  })

  it('the strip wins over a window edge zone reaching under it', () => {
    const edge: DropZoneEntry = { id: 'edge', workspaceId: 'ws', dock: main, host, edge: 'left', getRect: () => rect(0, 0, 60, 600) }
    expect(resolveDrop(cursor(20, 10), tabSource(), grab, size, 'terminal', { env: env([edge, zone]) })).toMatchObject({ kind: 'tab-slot' })
  })

  it('a dragged layout only reaches strips, and nothing outside the window', () => {
    const layout: DragSource = { workspaceId: 'ws', panelId: 'p', origin: { kind: 'layout', host, layoutId: 't' } }
    expect(over(100, layout)).toMatchObject({ kind: 'tab-slot' })
    const stack = stackEntry('s1', rect(0, 100, 400, 400))
    expect(resolveDrop(cursor(200, 150), layout, grab, size, 'terminal', { env: env([stack]) })).toBeNull()
    expect(resolveDrop(cursor(-5, 10, false), layout, grab, size, 'terminal', { env: env([zone]) })).toBeNull()
  })
})

describe('resolveDrop on a tree zone', () => {
  const host = { windowId: 'main' }
  const seen: Array<{ y: number; from?: string }> = []
  const tree: DropZoneEntry = {
    id: 'tree', workspaceId: 'ws', dock: { layoutId: '' }, host, getRect: () => rect(0, 0, 200, 600),
    tree: { resolve: (y, source) => { seen.push({ y, from: source.from }); return { kind: 'tab-slot', host, index: 2, via: 'tree' } } },
  }
  const layout: DragSource = { workspaceId: 'ws', panelId: 'p', from: 'sidebar', origin: { kind: 'layout', host, layoutId: 't' } }
  const at = (x: number, y: number, source: DragSource, zones: DropZoneEntry[]) => resolveDrop(cursor(x, y), source, grab, size, 'terminal', { env: env(zones) })

  it('a layout source is accepted by a tree zone', () => {
    expect(at(50, 100, layout, [tree])).toEqual({ kind: 'tab-slot', workspaceId: 'ws', host, index: 2, via: 'tree' })
  })

  it('a layout source is refused by a stack zone, canvas and split edge', () => {
    const edge: DropZoneEntry = { id: 'edge', workspaceId: 'ws', dock: main, host, edge: 'left', getRect: () => rect(0, 0, 60, 600) }
    expect(at(200, 150, layout, [stackEntry('s1', rect(0, 100, 400, 400))])).toBeNull()
    expect(at(20, 150, layout, [edge])).toBeNull()
    expect(resolveDrop(cursor(200, 10), layout, grab, size, 'terminal', { env: env([], canvasHit) })).toBeNull()
  })

  it('a panel source over a tree zone resolves through tree.resolve and adds workspaceId', () => {
    const panel: DragSource = { ...tabSource(), from: 'sidebar' }
    expect(at(50, 123, panel, [tree])).toEqual({ kind: 'tab-slot', workspaceId: 'ws', host, index: 2, via: 'tree' })
    expect(seen.at(-1)).toEqual({ y: 123, from: 'sidebar' })
  })

  it('the tree zone ranks with strips and stacks (before whole docks, even a tighter one)', () => {
    const dock: DropZoneEntry = { id: 'dock', workspaceId: 'ws', dock: main, host, getRect: () => rect(0, 0, 100, 200) }
    expect(at(50, 100, tabSource(), [dock, tree])).toMatchObject({ kind: 'tab-slot', via: 'tree' })
  })
})
