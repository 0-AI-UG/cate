// End-to-end drag scenarios over the document model: real dispatcher,
// runtime, hit testing and commit, asserting the document the drop produced.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { MAIN_WINDOW, dockOf, dockPanels, placementOf, type DocChange } from '@workspace/document/contract'
import { add, buildDocument } from '../../../../../../../test/clientWorkspace'
import type { CrossWindowPort, DragGhostPort } from '../ports'
import { WS, renderScene, type Scene } from './harness'

const main = { windowId: MAIN_WINDOW }
const rect = (x: number, y: number, w = 200, h = 150) => ({ origin: { x, y }, size: { width: w, height: h } })

let scene: Scene | null = null
afterEach(() => {
  scene?.unmount()
  scene = null
  document.body.classList.remove('canvas-interacting', 'canvas-dragging')
})

function canvasDoc(extra: DocChange[] = []) {
  return buildDocument([
    add('cv', { to: 'stack', dock: main, stackId: 's1' }, 'canvas', { canvasId: 'C' }),
    add('n1', { to: 'canvas', canvasId: 'C', nodeId: 'N1', stackId: 'ns1', rect: rect(100, 100) }),
    ...extra,
  ])
}

const canvasAt = (extra = {}) => ({ canvasId: 'C', rect: { x: 0, y: 0, w: 1000, h: 800 }, ...extra })

describe('canvas node drags', () => {
  it('moves a node by the exact client delta at zoom 1, in one op', () => {
    scene = renderScene({ doc: canvasDoc(), canvases: [canvasAt()] })
    const before = scene.workspace.document.seq
    scene.mouse.downOnNode('N1')
    scene.mouse.moveBy({ x: 50, y: 30 })
    scene.mouse.moveBy({ x: 10, y: 10 })
    // Nothing is sent while the pointer moves.
    expect(scene.workspace.document.seq).toBe(before)
    scene.mouse.up()
    expect(scene.doc().canvases.C.nodes.N1.rect).toEqual(rect(160, 140))
    expect(scene.workspace.document.seq).toBe(before + 1)
  })

  it('a canvas-space delta is the screen delta over the zoom', () => {
    scene = renderScene({ doc: canvasDoc(), canvases: [canvasAt({ zoom: 0.5 })] })
    scene.mouse.downOnNode('N1')
    scene.mouse.moveBy({ x: 100, y: 0 })
    scene.mouse.moveBy({ x: 10, y: 0 })
    scene.mouse.up()
    expect(scene.doc().canvases.C.nodes.N1.rect.origin.x).toBeCloseTo(100 + 110 / 0.5, 0)
  })

  it('a grabbed member of a selection moves the whole group by the same delta', () => {
    const doc = canvasDoc([
      add('n2', { to: 'canvas', canvasId: 'C', nodeId: 'N2', stackId: 'ns2', rect: rect(400, 100) }),
      add('n3', { to: 'canvas', canvasId: 'C', nodeId: 'N3', stackId: 'ns3', rect: rect(700, 100) }),
    ])
    scene = renderScene({ doc, canvases: [canvasAt()], selection: { C: ['N1', 'N2', 'N3'] } })
    scene.mouse.downOnNode('N2')
    scene.mouse.moveBy({ x: 50, y: 30 })
    scene.mouse.moveBy({ x: 10, y: 10 })
    scene.mouse.up()
    const nodes = scene.doc().canvases.C.nodes
    expect([nodes.N1, nodes.N2, nodes.N3].map((n) => n.rect.origin)).toEqual([{ x: 160, y: 140 }, { x: 460, y: 140 }, { x: 760, y: 140 }])
  })

  it('a 3px nudge does not start a drag', () => {
    scene = renderScene({ doc: canvasDoc(), canvases: [canvasAt()] })
    scene.mouse.downOnNode('N1')
    scene.mouse.moveBy({ x: 3, y: 0 })
    scene.mouse.up()
    expect(scene.drag().isDragging).toBe(false)
    expect(scene.doc().canvases.C.nodes.N1.rect).toEqual(rect(100, 100))
  })

  it('a drop on another canvas moves the panel there and removes the emptied node', () => {
    const doc = canvasDoc([
      add('cv2', { to: 'split', dock: main, beside: 's1', side: 'right', stackId: 's2', splitId: 'sp' }, 'canvas', { canvasId: 'D' }),
    ])
    scene = renderScene({ doc, canvases: [{ canvasId: 'C', rect: { x: 0, y: 0, w: 400, h: 800 } }, { canvasId: 'D', rect: { x: 500, y: 0, w: 400, h: 800 } }] })
    scene.mouse.downOnNode('N1')
    scene.mouse.moveTo({ x: 600, y: 400 })
    scene.mouse.moveBy({ x: 5, y: 5 })
    scene.mouse.up()
    expect(scene.doc().canvases.C.nodes.N1).toBeUndefined()
    expect(placementOf(scene.doc(), 'n1')?.dock).toMatchObject({ canvasId: 'D' })
  })

  it('while dragging, the source is the node; blur cancels', () => {
    scene = renderScene({ doc: canvasDoc(), canvases: [canvasAt()] })
    scene.mouse.downOnNode('N1')
    scene.mouse.moveBy({ x: 20, y: 20 })
    expect(scene.drag().source?.origin).toMatchObject({ kind: 'canvas-node', nodeId: 'N1' })
    scene.mouse.blur()
    expect(scene.drag().isDragging).toBe(false)
    expect(scene.doc().canvases.C.nodes.N1.rect).toEqual(rect(100, 100))
  })

  it('a second press during a drag is ignored; a second mouseup is harmless', () => {
    const doc = canvasDoc([add('n2', { to: 'canvas', canvasId: 'C', nodeId: 'N2', stackId: 'ns2', rect: rect(400, 400) })])
    scene = renderScene({ doc, canvases: [canvasAt()] })
    scene.mouse.downOnNode('N1')
    scene.mouse.moveBy({ x: 10, y: 10 })
    scene.mouse.downOnNode('N2')
    expect(scene.drag().source?.origin).toMatchObject({ nodeId: 'N1' })
    scene.mouse.up()
    scene.mouse.up()
    expect(scene.drag().isDragging).toBe(false)
  })
})

describe('leaving the window', () => {
  function shell() {
    const ghost: DragGhostPort = { show: vi.fn(), hide: vi.fn() }
    const crossWindow: CrossWindowPort = {
      begin: vi.fn(),
      cancel: vi.fn(),
      release: vi.fn().mockResolvedValue({ claimed: false }),
      onPointer: () => () => {},
      onEnd: () => () => {},
      claim: vi.fn(),
    }
    return { ghost, crossWindow }
  }

  it('shows the native ghost outside, and an unclaimed drop detaches into a new window', async () => {
    const ports = shell()
    scene = renderScene({ doc: canvasDoc(), canvases: [canvasAt()], features: ['windows'], shell: ports })
    scene.mouse.downOnNode('N1')
    scene.mouse.dragBy({ x: 60, y: 60 })
    scene.mouse.moveTo({ x: 2000, y: 400 })
    expect(ports.ghost.show).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS, panelId: 'n1' }), { x: 3000, y: 1400 })
    expect(ports.crossWindow.begin).toHaveBeenCalled()
    scene.mouse.up()
    await vi.waitFor(() => expect(Object.values(scene!.doc().windows).some((w) => w.kind === 'detached')).toBe(true))
    const detached = Object.values(scene.doc().windows).find((w) => w.kind === 'detached')!
    expect(dockPanels(detached.dock)).toEqual(['n1'])
    expect(scene.doc().canvases.C.nodes.N1).toBeUndefined()
    expect(scene.drag().pendingDetach).toEqual([])
  })

  it('a drop another window claimed sends nothing from here', async () => {
    const ports = shell()
    ;(ports.crossWindow.release as ReturnType<typeof vi.fn>).mockResolvedValue({ claimed: true })
    scene = renderScene({ doc: canvasDoc(), canvases: [canvasAt()], features: ['windows'], shell: ports })
    const seq = scene.workspace.document.seq
    scene.mouse.downOnNode('N1')
    scene.mouse.dragBy({ x: 60, y: 60 })
    scene.mouse.moveTo({ x: 2000, y: 400 })
    scene.mouse.up()
    await vi.waitFor(() => expect(ports.crossWindow.release).toHaveBeenCalled())
    expect(scene.workspace.document.seq).toBe(seq)
  })

  it('coming back cancels the relay', () => {
    const ports = shell()
    scene = renderScene({ doc: canvasDoc(), canvases: [canvasAt()], features: ['windows'], shell: ports })
    scene.mouse.downOnNode('N1')
    scene.mouse.dragBy({ x: 60, y: 60 })
    scene.mouse.moveTo({ x: 2000, y: 400 })
    scene.mouse.moveTo({ x: 300, y: 300 })
    expect(ports.ghost.hide).toHaveBeenCalled()
    expect(ports.crossWindow.cancel).toHaveBeenCalled()
    scene.mouse.up()
  })

  it('a group never leaves the window', async () => {
    const ports = shell()
    const doc = canvasDoc([add('n2', { to: 'canvas', canvasId: 'C', nodeId: 'N2', stackId: 'ns2', rect: rect(400, 100) })])
    scene = renderScene({ doc, canvases: [canvasAt()], features: ['windows'], shell: ports, selection: { C: ['N1', 'N2'] } })
    scene.mouse.downOnNode('N1')
    scene.mouse.dragBy({ x: 60, y: 60 })
    scene.mouse.moveTo({ x: 2000, y: 400 })
    scene.mouse.up()
    await Promise.resolve()
    expect(ports.ghost.show).not.toHaveBeenCalled()
    expect(scene.doc().canvases.C.nodes.N1.rect).toEqual(rect(100, 100))
    expect(scene.doc().canvases.C.nodes.N2.rect).toEqual(rect(400, 100))
  })
})

describe('dock tab drags', () => {
  const stacks = { s1: { x: 0, y: 0, w: 400, h: 600 }, s2: { x: 400, y: 0, w: 400, h: 600 } }

  it('a lone tab dropped on its own tab bar previews and changes nothing', () => {
    const doc = buildDocument([add('p1', { to: 'stack', dock: main, stackId: 's1' })])
    scene = renderScene({ doc, stacks })
    const seq = scene.workspace.document.seq
    scene.mouse.downOnTab('p1')
    scene.mouse.dragBy({ x: 20, y: 5 })
    scene.mouse.moveTo({ x: 120, y: 20 })
    expect(scene.drag().target).toMatchObject({ kind: 'dock-tab', stackId: 's1' })
    scene.mouse.up()
    expect(scene.workspace.document.seq).toBe(seq)
  })

  it('a tab dropped on another stack becomes a tab there', () => {
    const doc = buildDocument([
      add('p1', { to: 'stack', dock: main, stackId: 's1' }),
      add('p2', { to: 'stack', dock: main, stackId: 's1' }),
      add('p3', { to: 'split', dock: main, beside: 's1', side: 'right', stackId: 's2', splitId: 'sp' }),
    ])
    scene = renderScene({ doc, stacks })
    scene.mouse.downOnTab('p1')
    scene.mouse.dragBy({ x: 20, y: 5 })
    scene.mouse.moveTo({ x: 600, y: 15 })
    scene.mouse.up()
    expect(placementOf(scene.doc(), 'p1')?.stackId).toBe('s2')
    expect(scene.workspace.state.getSnapshot().activeTabs.s2).toBe('p1')
  })

  it('a tab dropped on a stack edge splits there', () => {
    const doc = buildDocument([
      add('p1', { to: 'stack', dock: main, stackId: 's1' }),
      add('p2', { to: 'stack', dock: main, stackId: 's1' }),
    ])
    scene = renderScene({ doc, stacks: { s1: { x: 0, y: 0, w: 800, h: 600 } } })
    scene.mouse.downOnTab('p2')
    scene.mouse.dragBy({ x: 20, y: 5 })
    scene.mouse.moveTo({ x: 795, y: 300 })
    expect(scene.drag().target).toMatchObject({ kind: 'dock-split', edge: 'right' })
    scene.mouse.up()
    const tree = dockOf(scene.doc(), main)
    expect(tree?.kind === 'split' && tree.children.map((c) => dockPanels(c))).toEqual([['p1'], ['p2']])
  })

  it('a tab dragged out onto a canvas becomes a node there', () => {
    const doc = canvasDoc([
      add('p1', { to: 'split', dock: main, beside: 's1', side: 'left', stackId: 's0', splitId: 'sp' }),
      add('p2', { to: 'stack', dock: main, stackId: 's0' }),
    ])
    scene = renderScene({ doc, stacks: { s0: { x: 0, y: 0, w: 260, h: 600 } }, canvases: [{ canvasId: 'C', rect: { x: 400, y: 0, w: 600, h: 600 } }] })
    scene.mouse.downOnTab('p2')
    scene.mouse.dragBy({ x: 30, y: 30 })
    scene.mouse.moveTo({ x: 700, y: 300 })
    expect(scene.drag().target?.kind).toBe('canvas-add')
    scene.mouse.up()
    expect(dockPanels(dockOf(scene.doc(), main))).toEqual(['p1', 'cv'])
    expect(placementOf(scene.doc(), 'p2')?.dock).toMatchObject({ canvasId: 'C' })
  })

  it('a canvas tab refuses a canvas and a node mini dock', () => {
    const doc = canvasDoc([add('p1', { to: 'split', dock: main, beside: 's1', side: 'left', stackId: 's0', splitId: 'sp' })])
    scene = renderScene({
      doc,
      stacks: { s1: { x: 0, y: 0, w: 260, h: 600 } },
      canvases: [{ canvasId: 'C', rect: { x: 400, y: 0, w: 600, h: 600 }, miniDocks: true }],
    })
    scene.mouse.downOnTab('cv')
    scene.mouse.dragBy({ x: 30, y: 30 })
    scene.mouse.moveTo({ x: 520, y: 110 })
    expect(scene.drag().target).toBeNull()
    scene.mouse.moveTo({ x: 800, y: 500 })
    expect(scene.drag().target).toBeNull()
    scene.mouse.up()
    expect(placementOf(scene.doc(), 'cv')?.stackId).toBe('s1')
  })

  it('a tab dropped on a node tab bar joins the node', () => {
    const doc = canvasDoc([
      add('p1', { to: 'split', dock: main, beside: 's1', side: 'left', stackId: 's0', splitId: 'sp' }),
      add('p2', { to: 'stack', dock: main, stackId: 's0' }),
    ])
    scene = renderScene({
      doc,
      stacks: { s0: { x: 0, y: 0, w: 260, h: 600 } },
      canvases: [{ canvasId: 'C', rect: { x: 400, y: 0, w: 600, h: 600 }, miniDocks: true }],
    })
    scene.mouse.downOnTab('p2')
    scene.mouse.dragBy({ x: 30, y: 30 })
    // Node N1 sits at canvas (100, 100): screen (500, 100); its tab bar is the top strip.
    scene.mouse.moveTo({ x: 560, y: 110 })
    expect(scene.drag().target).toMatchObject({ kind: 'dock-tab', dock: { canvasId: 'C', nodeId: 'N1' } })
    scene.mouse.up()
    expect(dockPanels(dockOf(scene.doc(), { canvasId: 'C', nodeId: 'N1' }))).toEqual(['n1', 'p2'])
  })
})
