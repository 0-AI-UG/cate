import { describe, expect, it } from 'vitest'
import { rect } from '@workspace/canvas/contract'
import { applyOp } from './apply'
import type { DockNode } from './dock'
import type { DocChange, DockRef, OpErrorCode, PlaceTarget } from './ops'
import { placementOf } from './placement'
import { createDocument, MAIN_WINDOW, type PanelRecord, type PanelType, type WorkspaceDocument } from './schema'
import { validateDocument } from './serialize'

type Doc = WorkspaceDocument

const MAIN: DockRef = { windowId: MAIN_WINDOW, layoutId: 'main' }
const R = rect(0, 0, 400, 300)

function record(id: string, type: PanelType = 'terminal', extra: Partial<PanelRecord> = {}): PanelRecord {
  return { id, type, title: id, fields: {}, ...(type === 'canvas' ? { canvasId: `canvas-${id}` } : {}), ...extra }
}

const tab = (stackId: string, after?: string | null, dock: DockRef = MAIN): PlaceTarget => ({ to: 'stack', dock, stackId, after })
const split = (beside: string, side: 'left' | 'right' | 'top' | 'bottom', stackId: string, splitId = `split-${stackId}`, dock: DockRef = MAIN): PlaceTarget =>
  ({ to: 'split', dock, beside, side, stackId, splitId })
const node = (canvasId: string, nodeId: string, stackId = `stack-${nodeId}`, r = R): PlaceTarget => ({ to: 'canvas', canvasId, nodeId, stackId, rect: r })
const win = (windowId: string, stackId = `stack-${windowId}`): PlaceTarget => ({ to: 'window', windowId, layoutId: 'main', stackId })

function ok(doc: Doc, ...changes: DocChange[]): Doc {
  for (const change of changes) {
    const result = applyOp(doc, change)
    if (result.error) throw new Error(`${change.kind}: ${result.error.code} ${result.error.message}`)
    expect(validateDocument(result.doc)).toBeNull()
    doc = result.doc
  }
  return doc
}

function fails(doc: Doc, change: DocChange, code: OpErrorCode): void {
  const result = applyOp(doc, change)
  expect(result.error?.code, JSON.stringify(result.error)).toBe(code)
  expect(result.doc).toBe(doc)
}

const add = (id: string, at: PlaceTarget, type: PanelType = 'terminal'): DocChange => ({ kind: 'addPanel', record: record(id, type), at })
const place = (id: string, at: PlaceTarget): DocChange => ({ kind: 'placePanel', id, at })
const mainDock = (doc: Doc) => doc.windows[MAIN_WINDOW].layouts[0].dock
const stack = (id: string, ...panels: string[]): DockNode => ({ kind: 'stack', id, panels })

/** main: stack s1 [a, b, c] */
function threeTabs(): Doc {
  return ok(createDocument(), add('a', tab('s1')), add('b', tab('s1')), add('c', tab('s1')))
}

/** main: canvas panel `cv` (canvas `canvas-cv`) with nodes n1 [x] and n2 [y] */
function withCanvas(): Doc {
  return ok(createDocument(), add('cv', tab('s1'), 'canvas'), add('x', node('canvas-cv', 'n1')), add('y', node('canvas-cv', 'n2')))
}

describe('createDocument', () => {
  it('has an empty main window and nothing else', () => {
    const doc = createDocument()
    expect(doc).toEqual({ panels: {}, windows: { main: { id: 'main', kind: 'main', layouts: [{ id: 'main', dock: null }]} }, canvases: {}, relations: {}, worktrees: {} })
    expect(validateDocument(doc)).toBeNull()
  })
})

describe('addPanel', () => {
  it('creates the named stack in an empty main window, then appends to it', () => {
    const doc = threeTabs()
    expect(mainDock(doc)).toEqual(stack('s1', 'a', 'b', 'c'))
    expect(placementOf(doc, 'b')).toEqual({ dock: MAIN, stackId: 's1', index: 1 })
  })

  it('inserts after a tab, first for null, and appends when `after` is missing', () => {
    let doc = ok(threeTabs(), add('d', tab('s1', 'a')))
    doc = ok(doc, add('e', tab('s1', null)))
    doc = ok(doc, add('f', tab('s1', 'nope')))
    expect(mainDock(doc)).toEqual(stack('s1', 'e', 'a', 'd', 'b', 'c', 'f'))
  })

  it('fails with gone for a missing stack, window or canvas', () => {
    const doc = threeTabs()
    fails(doc, add('d', tab('nope')), 'gone')
    fails(doc, add('d', tab('s1', undefined, { windowId: 'nope', layoutId: 'main' })), 'gone')
    fails(doc, add('d', node('nope', 'n1')), 'gone')
    fails(doc, add('d', split('nope', 'left', 's2')), 'gone')
  })

  it('rejects ids already in use and unknown panel types', () => {
    const doc = threeTabs()
    fails(doc, add('a', tab('s1')), 'rejected')
    fails(doc, add('d', split('s1', 'left', 's1')), 'rejected')
    fails(doc, add('d', win('main')), 'rejected')
    fails(doc, { kind: 'addPanel', record: { ...record('d'), type: 'agent' as PanelType }, at: tab('s1') }, 'rejected')
  })

  it('rejects malformed records', () => {
    const doc = threeTabs()
    fails(doc, { kind: 'addPanel', record: { ...record('d'), fields: undefined as never }, at: tab('s1') }, 'rejected')
    fails(doc, { kind: 'addPanel', record: { ...record('d'), canvasId: 'c' }, at: tab('s1') }, 'rejected')
    fails(doc, { kind: 'addPanel', record: { id: 'd', type: 'canvas', title: '', fields: {} }, at: tab('s1') }, 'rejected')
    fails(doc, { kind: 'addPanel', record: { ...record('d'), extra: 1 } as PanelRecord, at: tab('s1') }, 'rejected')
    fails(doc, { kind: 'addPanel', record: record('d'), at: node('c', 'n', 'sn', rect(0, 0, 0, 10)) }, 'rejected')
  })

  it('creates a canvas with its canvas panel', () => {
    const doc = ok(createDocument(), add('cv', tab('s1'), 'canvas'))
    expect(doc.canvases['canvas-cv']).toEqual({ id: 'canvas-cv', nodes: {} })
    fails(doc, { kind: 'addPanel', record: { ...record('cv2', 'canvas'), canvasId: 'canvas-cv' }, at: tab('s1') }, 'rejected')
  })

  it('never places a canvas panel on a canvas', () => {
    const doc = withCanvas()
    fails(doc, add('cv2', node('canvas-cv', 'n9'), 'canvas'), 'rejected')
    fails(doc, add('cv2', tab('stack-n1', undefined, { canvasId: 'canvas-cv', nodeId: 'n1' }), 'canvas'), 'rejected')
    fails(doc, add('cv2', split('stack-n1', 'left', 'sx', 'px', { canvasId: 'canvas-cv', nodeId: 'n1' }), 'canvas'), 'rejected')
  })

  it('adds canvas nodes with their rect and detached windows without a position', () => {
    const doc = ok(withCanvas(), add('w', win('w1', 'ws')))
    expect(doc.canvases['canvas-cv'].nodes.n1).toEqual({ id: 'n1', rect: R, dock: stack('stack-n1', 'x') })
    expect(Object.keys(doc.canvases['canvas-cv'].nodes)).toEqual(['n1', 'n2'])
    expect(doc.windows.w1).toEqual({ id: 'w1', kind: 'detached', layouts: [{ id: 'main', dock: stack('ws', 'w') }]})
  })
})

describe('placePanel', () => {
  it('moves a placed panel: it is only ever in one place', () => {
    const doc = ok(threeTabs(), add('d', split('s1', 'right', 's2')), place('a', tab('s2')))
    expect(mainDock(doc)).toMatchObject({ kind: 'split', children: [stack('s1', 'b', 'c'), stack('s2', 'd', 'a')] })
    expect(placementOf(doc, 'a')).toEqual({ dock: MAIN, stackId: 's2', index: 1 })
  })

  it('reorders within its own stack', () => {
    let doc = ok(threeTabs(), place('a', tab('s1', 'c')))
    expect(mainDock(doc)).toEqual(stack('s1', 'b', 'c', 'a'))
    doc = ok(doc, place('a', tab('s1', null)))
    expect(mainDock(doc)).toEqual(stack('s1', 'a', 'b', 'c'))
    expect(applyOp(doc, place('a', tab('s1', 'a'))).doc).toBe(doc)
  })

  it('removes a stack it empties and collapses a split left with one child', () => {
    let doc = ok(threeTabs(), add('d', split('s1', 'right', 's2', 'p1')))
    doc = ok(doc, place('d', tab('s1')))
    expect(mainDock(doc)).toEqual(stack('s1', 'a', 'b', 'c', 'd'))
  })

  it('keeps splits flat: a same-direction split gains an equal sibling', () => {
    let doc = ok(threeTabs(), add('d', split('s1', 'right', 's2', 'p1')), add('e', split('s2', 'right', 's3', 'p2')))
    expect(mainDock(doc)).toEqual({
      kind: 'split', id: 'p1', direction: 'horizontal',
      children: [stack('s1', 'a', 'b', 'c'), stack('s2', 'd'), stack('s3', 'e')],
      ratios: [1 / 3, 1 / 3, 1 / 3],
    })
    // Splitting beside the split itself joins it at that end.
    doc = ok(doc, add('f', split('p1', 'left', 's4', 'p3')))
    expect((mainDock(doc) as { children: DockNode[] }).children.map((c) => c.id)).toEqual(['s4', 's1', 's2', 's3'])
  })

  it('wraps in a new split for the other direction, before for left/top and after for right/bottom', () => {
    const doc = ok(threeTabs(), add('d', split('s1', 'top', 's2', 'p1')))
    expect(mainDock(doc)).toEqual({
      kind: 'split', id: 'p1', direction: 'vertical', children: [stack('s2', 'd'), stack('s1', 'a', 'b', 'c')], ratios: [0.5, 0.5],
    })
  })

  it('merges a split that collapses into a same-direction parent', () => {
    // main: H[s1, V[s2, H2[s3, s4]]]; emptying s2 collapses V into H2, which
    // runs in H's direction and merges into it.
    let doc = ok(threeTabs(), add('d', split('s1', 'right', 's2', 'h')), add('e', split('s2', 'bottom', 's3', 'v')), add('f', split('s3', 'right', 's4', 'h2')))
    expect(validateDocument(doc)).toBeNull()
    doc = ok(doc, place('d', tab('s1')))
    expect(mainDock(doc)).toMatchObject({ id: 'h', children: [{ id: 's1' }, { id: 's3' }, { id: 's4' }] })
  })

  it('is a no-op when the target is only there because of the panel itself', () => {
    const doc = ok(threeTabs(), add('d', split('s1', 'right', 's2', 'p1')))
    expect(applyOp(doc, place('d', split('s2', 'bottom', 's9', 'p9'))).doc).toBe(doc)
    const canvas = withCanvas()
    expect(applyOp(canvas, place('x', split('stack-n1', 'left', 's9', 'p9', { canvasId: 'canvas-cv', nodeId: 'n1' }))).doc).toBe(canvas)
  })

  it('follows a split that collapsed while the panel moved out', () => {
    // main: H(p1)[s1(a,b,c), s2(d)]; split d below p1: p1 collapses into s1
    const doc = ok(threeTabs(), add('d', split('s1', 'right', 's2', 'p1')), place('d', split('p1', 'bottom', 's3', 'p2')))
    expect(mainDock(doc)).toEqual({ kind: 'split', id: 'p2', direction: 'vertical', children: [stack('s1', 'a', 'b', 'c'), stack('s3', 'd')], ratios: [0.5, 0.5] })
  })

  it('removes a canvas node or detached window it empties, never the main window', () => {
    let doc = ok(withCanvas(), place('x', tab('s1')))
    expect(Object.keys(doc.canvases['canvas-cv'].nodes)).toEqual(['n2'])
    doc = ok(doc, place('x', win('w1')), place('x', tab('s1')))
    expect(doc.windows.w1).toBeUndefined()
    doc = ok(createDocument(), add('a', tab('s1')), place('a', win('w1')))
    expect(doc.windows.main).toEqual({ id: 'main', kind: 'main', layouts: [{ id: 'main', dock: null }]})
  })

  it('moves between nodes and into new nodes', () => {
    let doc = ok(withCanvas(), place('x', tab('stack-n2', undefined, { canvasId: 'canvas-cv', nodeId: 'n2' })))
    expect(doc.canvases['canvas-cv'].nodes.n2.dock).toEqual(stack('stack-n2', 'y', 'x'))
    doc = ok(doc, place('y', node('canvas-cv', 'n3', 's3', rect(5, 5, 100, 100))))
    expect(doc.canvases['canvas-cv'].nodes.n3.rect).toEqual(rect(5, 5, 100, 100))
  })

  it('fails with gone for a missing panel, rejected for a canvas panel onto a canvas', () => {
    const doc = withCanvas()
    fails(doc, place('nope', tab('s1')), 'gone')
    fails(doc, place('cv', node('canvas-cv', 'n9')), 'rejected')
    fails(doc, place('x', tab('nope', undefined, { canvasId: 'canvas-cv', nodeId: 'n1' })), 'gone')
  })

  it('shares every untouched part of the document', () => {
    const doc = ok(withCanvas(), add('w', win('w1')))
    const next = ok(doc, place('x', tab('stack-n2', undefined, { canvasId: 'canvas-cv', nodeId: 'n2' })))
    expect(next.windows).toBe(doc.windows)
    expect(next.panels).toBe(doc.panels)
    expect(next.relations).toBe(doc.relations)
  })
})

describe('replacePanel', () => {
  it('keeps the id and the placement', () => {
    const doc = ok(threeTabs(), { kind: 'replacePanel', record: { ...record('b', 'browser'), title: 'Browser', fields: { url: 'x' } } })
    expect(doc.panels.b).toEqual({ id: 'b', type: 'browser', title: 'Browser', fields: { url: 'x' } })
    expect(placementOf(doc, 'b')).toEqual({ dock: MAIN, stackId: 's1', index: 1 })
  })

  it('turns a docked surface into a canvas, never one on a canvas', () => {
    let doc = ok(withCanvas(), add('s', tab('s1'), 'surface'), add('t', tab('stack-n1', undefined, { canvasId: 'canvas-cv', nodeId: 'n1' }), 'surface'))
    doc = ok(doc, { kind: 'replacePanel', record: record('s', 'canvas') })
    expect(doc.canvases['canvas-s']).toEqual({ id: 'canvas-s', nodes: {} })
    fails(doc, { kind: 'replacePanel', record: record('t', 'canvas') }, 'rejected')
    fails(doc, { kind: 'replacePanel', record: { ...record('t', 'canvas'), canvasId: 'canvas-cv' } }, 'rejected')
  })

  it('replaces a canvas panel only while its canvas is empty, and drops the canvas', () => {
    fails(withCanvas(), { kind: 'replacePanel', record: record('cv') }, 'rejected')
    const doc = ok(createDocument(), add('cv', tab('s1'), 'canvas'), { kind: 'replacePanel', record: record('cv') })
    expect(doc.canvases).toEqual({})
  })

  it('fails with gone for a missing panel and rejected for an unknown type', () => {
    fails(threeTabs(), { kind: 'replacePanel', record: record('nope') }, 'gone')
    fails(threeTabs(), { kind: 'replacePanel', record: { ...record('a'), type: 'agent' as PanelType } }, 'rejected')
  })
})

describe('updatePanel', () => {
  it('sets the title, binds and unbinds a worktree, merges fields and deletes null ones', () => {
    let doc = ok(threeTabs(), { kind: 'updatePanel', id: 'a', patch: { title: 'T', worktreeId: 'w1', fields: { p: 1, q: 'x' } } })
    expect(doc.panels.a).toEqual({ id: 'a', type: 'terminal', title: 'T', worktreeId: 'w1', fields: { p: 1, q: 'x' } })
    doc = ok(doc, { kind: 'updatePanel', id: 'a', patch: { worktreeId: null, fields: { p: null, r: [1] } } })
    expect(doc.panels.a).toEqual({ id: 'a', type: 'terminal', title: 'T', fields: { q: 'x', r: [1] } })
  })

  it('last write wins', () => {
    const doc = ok(threeTabs(), { kind: 'updatePanel', id: 'a', patch: { title: '1' } }, { kind: 'updatePanel', id: 'a', patch: { title: '2' } })
    expect(doc.panels.a.title).toBe('2')
  })

  it('fails with gone for a missing panel and rejects non-JSON fields', () => {
    fails(threeTabs(), { kind: 'updatePanel', id: 'nope', patch: { title: 'x' } }, 'gone')
    fails(threeTabs(), { kind: 'updatePanel', id: 'a', patch: { fields: { f: Number.NaN } } }, 'rejected')
  })
})

describe('removePanels', () => {
  it('removes records and placements, cleaning up emptied containers and relations', () => {
    let doc = ok(threeTabs(), add('d', split('s1', 'right', 's2', 'p1')), add('w', win('w1')),
      { kind: 'addRelation', relation: { id: 'r1', fromPanelId: 'a', toPanelId: 'd', kind: 'use' } },
      { kind: 'addRelation', relation: { id: 'r2', fromPanelId: 'a', toPanelId: 'b', kind: 'use' } })
    doc = ok(doc, { kind: 'removePanels', ids: ['d', 'w'] })
    expect(mainDock(doc)).toEqual(stack('s1', 'a', 'b', 'c'))
    expect(doc.windows.w1).toBeUndefined()
    expect(Object.keys(doc.relations)).toEqual(['r2'])
    expect(Object.keys(doc.panels)).toEqual(['a', 'b', 'c'])
  })

  it('removes a canvas panel with its canvas and the panels on it', () => {
    const doc = ok(withCanvas(), add('z', tab('s1')), { kind: 'removePanels', ids: ['cv'] })
    expect(Object.keys(doc.panels)).toEqual(['z'])
    expect(doc.canvases).toEqual({})
    expect(mainDock(doc)).toEqual(stack('s1', 'z'))
  })

  it('fails with gone when any id is missing', () => {
    fails(threeTabs(), { kind: 'removePanels', ids: ['a', 'nope'] }, 'gone')
    fails(threeTabs(), { kind: 'removePanels', ids: [] }, 'rejected')
  })
})

describe('containers', () => {
  const twoStacks = () => ok(threeTabs(), add('d', split('s1', 'right', 's2', 'p1')))

  it('setSplitRatio normalises, in window and node docks', () => {
    let doc = ok(twoStacks(), { kind: 'setSplitRatio', splitId: 'p1', ratios: [3, 1] })
    expect(mainDock(doc)).toMatchObject({ ratios: [0.75, 0.25] })
    const ref = { canvasId: 'canvas-cv', nodeId: 'n1' }
    doc = ok(withCanvas(), add('q', split('stack-n1', 'bottom', 'sq', 'pq', ref)), { kind: 'setSplitRatio', splitId: 'pq', ratios: [1, 4] })
    expect(doc.canvases['canvas-cv'].nodes.n1.dock).toMatchObject({ ratios: [0.2, 0.8] })
  })

  it('setSplitRatio fails for a missing split and rejects a wrong count or bad values', () => {
    fails(twoStacks(), { kind: 'setSplitRatio', splitId: 'nope', ratios: [1, 1] }, 'gone')
    fails(twoStacks(), { kind: 'setSplitRatio', splitId: 'p1', ratios: [1, 1, 1] }, 'rejected')
    fails(twoStacks(), { kind: 'setSplitRatio', splitId: 'p1', ratios: [1, -1] }, 'rejected')
  })

  it('setNodeRects moves and resizes nodes, last write wins', () => {
    const doc = ok(withCanvas(), { kind: 'setNodeRects', canvasId: 'canvas-cv', rects: [{ nodeId: 'n1', rect: rect(1, 2, 3, 4) }, { nodeId: 'n2', rect: rect(5, 6, 7, 8) }] })
    expect(doc.canvases['canvas-cv'].nodes.n1.rect).toEqual(rect(1, 2, 3, 4))
    expect(doc.canvases['canvas-cv'].nodes.n2.rect).toEqual(rect(5, 6, 7, 8))
    fails(doc, { kind: 'setNodeRects', canvasId: 'canvas-cv', rects: [{ nodeId: 'n1', rect: R }, { nodeId: 'nope', rect: R }] }, 'gone')
    fails(doc, { kind: 'setNodeRects', canvasId: 'nope', rects: [] }, 'gone')
    fails(doc, { kind: 'setNodeRects', canvasId: 'canvas-cv', rects: [{ nodeId: 'n1', rect: rect(0, 0, -1, 1) }] }, 'rejected')
  })


  it('closeWindow removes the window and its panels, canvases included', () => {
    let doc = ok(withCanvas(), add('w', win('w1')), place('cv', tab('stack-w1', undefined, { windowId: 'w1', layoutId: 'main' })))
    doc = ok(doc, { kind: 'closeWindow', windowId: 'w1' })
    expect(Object.keys(doc.panels)).toEqual([])
    expect(doc.canvases).toEqual({})
    expect(Object.keys(doc.windows)).toEqual(['main'])
    fails(doc, { kind: 'closeWindow', windowId: 'main' }, 'rejected')
    fails(doc, { kind: 'closeWindow', windowId: 'w1' }, 'gone')
  })
})

describe('relations', () => {
  const rel = (id: string, from: string, to: string) => ({ kind: 'addRelation' as const, relation: { id, fromPanelId: from, toPanelId: to, kind: 'use' as const } })

  it('adds, updates and removes', () => {
    let doc = ok(threeTabs(), rel('r1', 'a', 'b'))
    doc = ok(doc, { kind: 'updateRelation', id: 'r1', patch: { kind: 'verify', label: 'L', waypoint: { x: 1, y: 2 } } })
    expect(doc.relations.r1).toEqual({ id: 'r1', fromPanelId: 'a', toPanelId: 'b', kind: 'verify', label: 'L', waypoint: { x: 1, y: 2 } })
    doc = ok(doc, { kind: 'updateRelation', id: 'r1', patch: { label: null, waypoint: null } })
    expect(doc.relations.r1).toEqual({ id: 'r1', fromPanelId: 'a', toPanelId: 'b', kind: 'verify' })
    doc = ok(doc, { kind: 'removeRelation', id: 'r1' })
    expect(doc.relations).toEqual({})
  })

  it('fails for missing ids and rejects self, repeated pairs and reused ids', () => {
    const doc = ok(threeTabs(), rel('r1', 'a', 'b'))
    fails(doc, rel('r2', 'a', 'nope'), 'gone')
    fails(doc, rel('r2', 'a', 'a'), 'rejected')
    fails(doc, rel('r2', 'a', 'b'), 'rejected')
    fails(doc, rel('r1', 'b', 'c'), 'rejected')
    fails(doc, { kind: 'updateRelation', id: 'nope', patch: {} }, 'gone')
    fails(doc, { kind: 'removeRelation', id: 'nope' }, 'gone')
    fails(doc, { kind: 'updateRelation', id: 'r1', patch: { kind: 'bogus' as never } }, 'rejected')
  })
})

describe('worktrees', () => {
  const wt = { id: 'w1', path: '/repo/.cate/worktrees/x', color: '#f00', status: 'creating' as const }

  it('setWorktree adds and replaces metadata; removeWorktree drops it and leaves panels alone', () => {
    let doc = ok(threeTabs(), { kind: 'setWorktree', worktree: wt }, { kind: 'updatePanel', id: 'a', patch: { worktreeId: 'w1' } })
    doc = ok(doc, { kind: 'setWorktree', worktree: { ...wt, status: 'ready', label: 'L' } })
    expect(doc.worktrees.w1).toEqual({ ...wt, status: 'ready', label: 'L' })
    doc = ok(doc, { kind: 'removeWorktree', id: 'w1' })
    expect(doc.worktrees).toEqual({})
    expect(doc.panels.a.worktreeId).toBe('w1')
    fails(doc, { kind: 'removeWorktree', id: 'w1' }, 'gone')
    fails(doc, { kind: 'setWorktree', worktree: { ...wt, status: 'gone' as never } }, 'rejected')
  })
})

describe('batch', () => {
  it('applies every change or none', () => {
    const doc = threeTabs()
    const good = applyOp(doc, { kind: 'batch', changes: [add('d', tab('s1')), place('d', win('w1'))] })
    expect(good.error).toBeUndefined()
    expect(placementOf(good.doc, 'd')?.dock).toEqual({ windowId: 'w1', layoutId: 'main' })
    const bad = applyOp(doc, { kind: 'batch', changes: [add('d', tab('s1')), place('nope', tab('s1'))] })
    expect(bad.error?.code).toBe('gone')
    expect(bad.doc).toBe(doc)
  })

  it('rejects an unknown change kind', () => {
    fails(threeTabs(), { kind: 'dropTable' } as unknown as DocChange, 'rejected')
  })
})
