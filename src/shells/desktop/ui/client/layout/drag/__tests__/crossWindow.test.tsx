// A drag relayed from another window of this client: this window mirrors it
// through its own runtime and, on release, claims the drop through the shell
// before it sends the placement op.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { Point } from '@workspace/canvas/contract'
import { MAIN_WINDOW, canvasOf, dockPanels, dockOf, placementOf } from '@workspace/document/contract'
import { add, buildDocument } from '../../../../../../../test/clientWorkspace'
import { setupCrossWindowDrops, shouldIgnoreDragEnd } from '../crossWindow'
import type { CrossWindowDrag, CrossWindowPort } from '../ports'
import { domDropEnvironment } from '../resolve'
import { WS, renderScene, type Scene } from './harness'

const main = { layoutId: 'main' }

function relay(claim = true) {
  let pointer: ((drag: CrossWindowDrag, screen: Point) => void) | null = null
  let end: ((dragId: string) => void) | null = null
  const port: CrossWindowPort = {
    begin: vi.fn(),
    cancel: vi.fn(),
    release: vi.fn(),
    onPointer: (listener) => { pointer = listener; return () => { pointer = null } },
    onEnd: (listener) => { end = listener; return () => { end = null } },
    claim: vi.fn().mockResolvedValue(claim),
  }
  return {
    port,
    move: (drag: CrossWindowDrag, p: Point) => act(() => pointer?.(drag, p)),
    end: (dragId: string) => act(() => end?.(dragId)),
  }
}

// The panel lives in a detached window rendered by another client window.
function fixture() {
  return buildDocument([
    add('p1', { to: 'stack', dock: main, stackId: 's1' }),
    add('p1b', { to: 'stack', dock: main, stackId: 's1' }),
    add('cv', { to: 'split', dock: main, beside: 's1', side: 'right', stackId: 's2', splitId: 'sp' }, 'canvas', { canvasId: 'C' }),
    add('far', { to: 'window', windowId: 'W1', layoutId: 'W1-main', stackId: 'ws1' }),
  ])
}

const drag = (dragId = 'd1'): CrossWindowDrag => ({
  dragId, workspaceId: WS, panelId: 'far', panelType: 'terminal', title: 'far', size: { width: 300, height: 200 }, grab: { x: 12, y: 12 },
})

let scene: Scene | null = null
let stop: (() => void) | null = null
afterEach(() => {
  stop?.()
  stop = null
  scene?.unmount()
  scene = null
})

function setup(claim = true) {
  scene = renderScene({
    doc: fixture(),
    stacks: { s1: { x: 0, y: 0, w: 400, h: 600 } },
    canvases: [{ canvasId: 'C', rect: { x: 500, y: 0, w: 500, h: 600 } }],
  })
  const r = relay(claim)
  stop = setupCrossWindowDrops(r.port, () => domDropEnvironment(() => false))
  return r
}

describe('a relayed drag', () => {
  it('starts only once the cursor enters, and mirrors its target', () => {
    const r = setup()
    r.move(drag(), { x: -50, y: 10 })
    expect(scene!.drag().isDragging).toBe(false)
    r.move(drag(), { x: 120, y: 15 })
    expect(scene!.drag().source?.origin).toMatchObject({ kind: 'remote' })
    expect(scene!.drag().target).toMatchObject({ kind: 'dock-tab', stackId: 's1' })
  })

  it('an accepted claim on a dock sends the placement from this window', async () => {
    const r = setup()
    r.move(drag(), { x: 120, y: 15 })
    r.end('d1')
    await vi.waitFor(() => expect(placementOf(scene!.doc(), 'far')?.stackId).toBe('s1'))
    expect(r.port.claim).toHaveBeenCalledWith('d1')
    expect(scene!.doc().windows.W1).toBeUndefined()
  })

  it('an accepted claim on a canvas adds a node', async () => {
    const r = setup()
    r.move(drag(), { x: 700, y: 300 })
    expect(scene!.drag().target?.kind).toBe('canvas-add')
    r.end('d1')
    await vi.waitFor(() => expect(canvasOf(scene!.doc(), 'far')).toBe('C'))
  })

  it('a refused claim sends nothing', async () => {
    const r = setup(false)
    const seq = scene!.workspace.document.seq
    r.move(drag(), { x: 120, y: 15 })
    r.end('d1')
    await vi.waitFor(() => expect(r.port.claim).toHaveBeenCalled())
    await Promise.resolve()
    expect(scene!.workspace.document.seq).toBe(seq)
    expect(dockPanels(dockOf(scene!.doc(), { layoutId: 'W1-main' }))).toEqual(['far'])
  })

  it('no target: no claim, state cleared', () => {
    const r = setup()
    r.move(drag(), { x: 450, y: 300 })
    r.end('d1')
    expect(r.port.claim).not.toHaveBeenCalled()
    expect(scene!.drag().isDragging).toBe(false)
  })

  it('an end for another drag is ignored', () => {
    const r = setup()
    r.move(drag('d1'), { x: 120, y: 15 })
    r.end('other')
    expect(scene!.drag().isDragging).toBe(true)
    r.end('d1')
    expect(scene!.drag().isDragging).toBe(false)
  })

  it('cleanup mid-drag cancels it', () => {
    const r = setup()
    r.move(drag(), { x: 120, y: 15 })
    act(() => { stop?.(); stop = null })
    expect(scene!.drag().isDragging).toBe(false)
  })
})

describe('a relayed layout drag', () => {
  const layoutDrag = (): CrossWindowDrag => ({ ...drag(), panelId: 'far', title: 'Far', layoutId: 'W1-main' })
  const open = (claim = true) => {
    scene = renderScene({
      doc: buildDocument([
        add('p1', { to: 'stack', dock: main, stackId: 's1' }),
        add('far', { to: 'window', windowId: 'W1', layoutId: 'W1-main', stackId: 'ws1' }),
        add('far2', { to: 'split', dock: { layoutId: 'W1-main' }, beside: 'ws1', side: 'right', stackId: 'ws2', splitId: 'wsp' }),
      ]),
      stacks: { s1: { x: 0, y: 30, w: 1000, h: 570 } },
      rects: {
        '[data-window-view]': { x: 0, y: 0, w: 1000, h: 600 },
        '[data-window-header]': { x: 0, y: 0, w: 1000, h: 24 },
        '[data-strip-panel-id="p1"]': { x: 25, y: 0, w: 100, h: 24 },
      },
      window: true,
    })
    const r = relay(claim)
    stop = setupCrossWindowDrops(r.port, () => domDropEnvironment(() => false))
    return r
  }

  it('moves the whole layout, name and panes, into this window on an accepted claim', async () => {
    const r = open()
    r.move(layoutDrag(), { x: 900, y: 10 })
    expect(scene!.drag().source?.origin).toMatchObject({ kind: 'layout', layoutId: 'W1-main' })
    expect(scene!.drag().target).toMatchObject({ kind: 'tab-slot' })
    r.end('d1')
    await vi.waitFor(() => expect(scene!.doc().windows.W1).toBeUndefined())
    const layouts = scene!.doc().windows[MAIN_WINDOW].layouts
    expect(layouts.map((l) => l.id)).toEqual(['main', 'W1-main'])
    expect(dockPanels(layouts[1].dock)).toEqual(['far', 'far2'])
  })

  it('a refused claim leaves the layout where it was', async () => {
    const r = open(false)
    const seq = scene!.workspace.document.seq
    r.move(layoutDrag(), { x: 900, y: 10 })
    r.end('d1')
    await vi.waitFor(() => expect(r.port.claim).toHaveBeenCalled())
    await Promise.resolve()
    expect(scene!.workspace.document.seq).toBe(seq)
  })
})

describe('shouldIgnoreDragEnd', () => {
  it('ignores an end for a different drag', () => {
    expect(shouldIgnoreDragEnd('a', 'b')).toBe(true)
    expect(shouldIgnoreDragEnd('a', 'a')).toBe(false)
  })
})
