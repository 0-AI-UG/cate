import { describe, expect, it } from 'vitest'
import { rect } from '@workspace/canvas/contract'
import { applyOp } from './apply'
import { applicable, invertOp } from './invert'
import type { DocChange, DockRef, PlaceTarget } from './ops'
import { createDocument, MAIN_WINDOW, type PanelRecord, type PanelType, type WorkspaceDocument } from './schema'

type Doc = WorkspaceDocument
const MAIN: DockRef = { windowId: MAIN_WINDOW }
const R = rect(0, 0, 400, 300)

const record = (id: string, type: PanelType = 'terminal'): PanelRecord =>
  ({ id, type, title: id, fields: {}, ...(type === 'canvas' ? { canvasId: `canvas-${id}` } : {}) })
const tab = (stackId: string, dock: DockRef = MAIN): PlaceTarget => ({ to: 'stack', dock, stackId })
const add = (id: string, at: PlaceTarget, type: PanelType = 'terminal'): DocChange => ({ kind: 'addPanel', record: record(id, type), at })

function build(...changes: DocChange[]): Doc {
  const result = applyOp(createDocument(), { kind: 'batch', changes })
  if (result.error) throw new Error(result.error.message)
  return result.doc
}

let n = 0
const newId = () => `new-${++n}`

/** Apply, invert, apply the inverse: back to where it started. */
function roundTrip(before: Doc, change: DocChange): DocChange[] {
  const after = applyOp(before, change)
  expect(after.error).toBeUndefined()
  const inverse = invertOp(before, change, newId)
  const undone = applyOp(after.doc, { kind: 'batch', changes: inverse })
  expect(undone.error).toBeUndefined()
  expect(undone.doc).toEqual(before)
  return inverse
}

// main: H(p1)[s1(a, b), V(p2)[s2(c), s3(d)]] with ratios set; canvas panel cv
// on a tab in s1 whose canvas has node n1(x, y) and n2(z); detached w1(w).
function sample(): Doc {
  return build(
    add('a', tab('s1')), add('b', tab('s1')),
    add('c', { to: 'split', dock: MAIN, beside: 's1', side: 'right', stackId: 's2', splitId: 'p1' }),
    add('d', { to: 'split', dock: MAIN, beside: 's2', side: 'bottom', stackId: 's3', splitId: 'p2' }),
    { kind: 'setSplitRatio', splitId: 'p1', ratios: [0.7, 0.3] },
    { kind: 'setSplitRatio', splitId: 'p2', ratios: [0.2, 0.8] },
    add('cv', tab('s1'), 'canvas'),
    add('x', { to: 'canvas', canvasId: 'canvas-cv', nodeId: 'n1', stackId: 'sn1', rect: R }),
    add('y', tab('sn1', { canvasId: 'canvas-cv', nodeId: 'n1' })),
    add('z', { to: 'canvas', canvasId: 'canvas-cv', nodeId: 'n2', stackId: 'sn2', rect: rect(500, 0, 300, 200) }),
    add('w', { to: 'window', windowId: 'w1', stackId: 'sw', bounds: rect(10, 10, 600, 400) }),
    { kind: 'addRelation', relation: { id: 'r1', fromPanelId: 'a', toPanelId: 'x', kind: 'context', label: 'L' } },
    { kind: 'setWorktree', worktree: { id: 'wt', path: '/r/wt', color: '#fff', status: 'ready' } },
  )
}

describe('invertOp', () => {
  it('undoes addPanel with removePanels', () => {
    expect(roundTrip(sample(), add('e', tab('s2')))).toEqual([{ kind: 'removePanels', ids: ['e'] }])
  })

  it('undoes a removal: records, placement, emptied stacks and splits, ratios, relations', () => {
    const doc = sample()
    roundTrip(doc, { kind: 'removePanels', ids: ['c'] })
    roundTrip(doc, { kind: 'removePanels', ids: ['a', 'd', 'w'] })
    roundTrip(doc, { kind: 'removePanels', ids: ['x'] })
  })

  it('undoes removing a canvas panel: canvas, nodes and rects come back', () => {
    roundTrip(sample(), { kind: 'removePanels', ids: ['cv'] })
  })

  it('undoes moves out of stacks, splits, nodes and windows', () => {
    const doc = sample()
    roundTrip(doc, { kind: 'placePanel', id: 'c', at: tab('s1') })
    roundTrip(doc, { kind: 'placePanel', id: 'b', at: { to: 'stack', dock: MAIN, stackId: 's1', after: null } })
    roundTrip(doc, { kind: 'placePanel', id: 'z', at: tab('s3') })
    roundTrip(doc, { kind: 'placePanel', id: 'w', at: tab('s2') })
    roundTrip(doc, { kind: 'placePanel', id: 'd', at: { to: 'window', windowId: 'w2', stackId: 'sw2', bounds: R } })
    roundTrip(doc, { kind: 'placePanel', id: 'a', at: { to: 'split', dock: MAIN, beside: 'p1', side: 'bottom', stackId: 's9', splitId: 'p9' } })
  })

  it('undoes closeWindow and the container and record edits', () => {
    const doc = sample()
    roundTrip(doc, { kind: 'closeWindow', windowId: 'w1' })
    roundTrip(doc, { kind: 'setSplitRatio', splitId: 'p1', ratios: [1, 1] })
    roundTrip(doc, { kind: 'setNodeRects', canvasId: 'canvas-cv', rects: [{ nodeId: 'n2', rect: R }] })
    roundTrip(doc, { kind: 'setWindowBounds', windowId: 'w1', bounds: R })
    roundTrip(doc, { kind: 'updatePanel', id: 'a', patch: { title: 'T', worktreeId: 'wt', fields: { k: 1 } } })
    roundTrip(doc, { kind: 'replacePanel', record: record('a', 'browser') })
  })

  it('undoes relation and worktree ops', () => {
    const doc = sample()
    roundTrip(doc, { kind: 'addRelation', relation: { id: 'r2', fromPanelId: 'b', toPanelId: 'c', kind: 'use' } })
    roundTrip(doc, { kind: 'updateRelation', id: 'r1', patch: { label: null, kind: 'use', waypoint: { x: 1, y: 1 } } })
    roundTrip(doc, { kind: 'removeRelation', id: 'r1' })
    roundTrip(doc, { kind: 'setWorktree', worktree: { id: 'wt2', path: '/r/2', color: '#000', status: 'creating' } })
    roundTrip(doc, { kind: 'setWorktree', worktree: { id: 'wt', path: '/r/wt', color: '#000', status: 'removing' } })
    roundTrip(doc, { kind: 'removeWorktree', id: 'wt' })
  })

  it('undoes maximizing with a restore, and a restore with the same maximize', () => {
    const doc = sample()
    expect(roundTrip(doc, { kind: 'maximizeStack', windowId: MAIN_WINDOW, stackId: 's2' })).toEqual([{ kind: 'restoreLayout', windowId: MAIN_WINDOW }])
    for (const id of ['x', 'z']) {
      const maximized = applyOp(doc, { kind: 'maximizePanel', id }).doc
      expect(roundTrip(maximized, { kind: 'restoreLayout', windowId: MAIN_WINDOW })).toEqual([{ kind: 'maximizePanel', id }])
    }
  })

  it('undoes a batch in reverse order', () => {
    roundTrip(sample(), {
      kind: 'batch',
      changes: [add('e', tab('s2')), { kind: 'placePanel', id: 'e', at: tab('s1') }, { kind: 'removePanels', ids: ['c'] }],
    } as unknown as DocChange)
  })

  it('has nothing to undo for an op that failed', () => {
    expect(invertOp(sample(), { kind: 'removePanels', ids: ['nope'] }, newId)).toEqual([])
  })
})

describe('applicable', () => {
  it('skips the parts of an inverse that are gone by the time it is sent', () => {
    const before = sample()
    const change: DocChange = { kind: 'updatePanel', id: 'c', patch: { title: 'T' } }
    const after = applyOp(before, change).doc
    const inverse = [...invertOp(before, change, newId), { kind: 'removeRelation', id: 'r1' } as DocChange]
    // Someone else removed c and r1 in the meantime.
    const later = applyOp(after, { kind: 'removePanels', ids: ['c', 'a'] }).doc
    expect(applicable(later, inverse)).toEqual([])
    expect(applicable(after, inverse)).toEqual(inverse)
  })
})
