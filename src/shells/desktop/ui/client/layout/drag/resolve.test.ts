import { beforeAll, describe, expect, it } from 'vitest'
import { MAIN_WINDOW, type DockRef } from '@workspace/document/contract'
import { registerPanelDefinitions } from '@client/host'
import { testPanelDefinitions } from '../../../../../../test/clientWorkspace'
import { resolveDrop, type CanvasHit, type DropEnvironment } from './resolve'
import { resolveDropEdge, type DropZoneEntry } from './registry'
import type { DragSource } from './types'

beforeAll(() => registerPanelDefinitions(testPanelDefinitions()))

const main: DockRef = { windowId: MAIN_WINDOW }
const rect = (x: number, y: number, w: number, h: number) => new DOMRectShim(x, y, w, h) as unknown as DOMRect

class DOMRectShim {
  constructor(public x: number, public y: number, public width: number, public height: number) {}
  get left() { return this.x }
  get top() { return this.y }
  get right() { return this.x + this.width }
  get bottom() { return this.y + this.height }
}

function stackEntry(stackId: string, r: DOMRect, extra: Partial<DropZoneEntry> = {}): DropZoneEntry {
  return { id: stackId, workspaceId: 'ws', dock: main, stackId, getRect: () => r, tabCount: () => 2, ...extra }
}

function env(dropZones: DropZoneEntry[], canvas: CanvasHit | null = null, canDetach = true): DropEnvironment {
  return { dropZones, canvasAtCursor: () => canvas, canDetach: () => canDetach }
}

const cursor = (x: number, y: number, insideWindow = true) => ({ client: { x, y }, screen: { x: x + 1000, y: y + 1000 }, insideWindow })
const tabSource = (stackId = 'other'): DragSource => ({ workspaceId: 'ws', panelId: 'p', origin: { kind: 'dock-tab', dock: main, stackId } })
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
      { id: 'dock', workspaceId: 'ws', dock: main, getRect: () => rect(0, 0, 1000, 1000) },
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
    const nodeDock = stackEntry('ns', rect(0, 0, 400, 400), { dock: { canvasId: 'C', nodeId: 'N9' } })
    expect(resolveDrop(cursor(200, 10), tabSource(), grab, size, 'canvas', { env: env([nodeDock], canvasHit) })).toBeNull()
  })

  it('a dragged node never drops into its own mini dock', () => {
    const own = stackEntry('ns1', rect(0, 0, 400, 400), { dock: { canvasId: 'C', nodeId: 'N1' } })
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
    const fromNodeDock: DragSource = { workspaceId: 'ws', panelId: 'p', origin: { kind: 'dock-tab', dock: { canvasId: 'C', nodeId: 'N1' }, stackId: 'ns1' } }
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
