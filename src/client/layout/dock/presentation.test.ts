import { describe, expect, it } from 'vitest'
import { MAIN_WINDOW, applyOp, dockOf, dockPanels, type DocChange, type WorkspaceDocument } from '@workspace/document/contract'
import { add, buildDocument } from '../testing'
import {
  createPresentationStore,
  materialize,
  presentedNodeDock,
  presentedWindowDock,
  promotedPanels,
} from './presentation'

const main = { windowId: MAIN_WINDOW }
const node = { canvasId: 'C', nodeId: 'N1' }
const rect = { origin: { x: 0, y: 0 }, size: { width: 400, height: 300 } }

function fixture(): WorkspaceDocument {
  return buildDocument([
    add('cv', { to: 'stack', dock: main, stackId: 's1' }, 'canvas', { canvasId: 'C' }),
    add('p1', { to: 'stack', dock: main, stackId: 's1' }),
    add('p3', { to: 'split', dock: main, beside: 's1', side: 'right', stackId: 's2', splitId: 'sp' }),
    add('a', { to: 'canvas', canvasId: 'C', nodeId: 'N1', stackId: 'ns1', rect }),
    add('b', { to: 'stack', dock: node, stackId: 'ns1' }),
    add('solo', { to: 'canvas', canvasId: 'C', nodeId: 'N2', stackId: 'ns2', rect: { ...rect, origin: { x: 500, y: 0 } } }),
  ])
}

let n = 0
const apply = (doc: WorkspaceDocument, change: DocChange): WorkspaceDocument => {
  const result = applyOp(doc, { ...change, opId: { clientId: 't', counter: ++n } } as Parameters<typeof applyOp>[1])
  if (result.error) throw new Error(result.error.message)
  return result.doc
}

function harness(initial = fixture()) {
  let doc = initial
  const shown: [string, string][] = []
  const store = createPresentationStore(() => doc, (stackId, panelId) => shown.push([stackId, panelId]))
  return {
    store,
    shown,
    get doc() { return doc },
    change(change: DocChange) {
      doc = apply(doc, change)
      store.check(doc)
    },
  }
}

describe('merge (maximize a main-dock split)', () => {
  it('draws the whole tree as the chosen stack, in tree order, without touching the document', () => {
    const h = harness()
    const before = h.doc
    expect(h.store.merge(MAIN_WINDOW, 's2')).toBe(true)
    const drawn = presentedWindowDock(h.doc, MAIN_WINDOW, h.store.getSnapshot())
    expect(drawn).toEqual({ kind: 'stack', id: 's2', panels: ['cv', 'p1', 'p3'] })
    expect(h.doc).toBe(before)
  })

  it('stays valid across a ratio change and restores the exact tree', () => {
    const h = harness()
    h.store.merge(MAIN_WINDOW, 's1')
    h.change({ kind: 'setSplitRatio', splitId: 'sp', ratios: [0.3, 0.7] })
    const [presentation] = h.store.getSnapshot()
    expect(presentation).toBeDefined()
    expect(h.store.restore(presentation)).toBe(true)
    expect(h.store.getSnapshot()).toEqual([])
    expect(presentedWindowDock(h.doc, MAIN_WINDOW, [])).toBe(h.doc.windows[MAIN_WINDOW].dock)
  })

  it('is consumed for good by a structural change', () => {
    const h = harness()
    h.store.merge(MAIN_WINDOW, 's1')
    h.change({ kind: 'removePanels', ids: ['p3'] })
    expect(h.store.getSnapshot()).toEqual([])
  })

  it('never nests: a second maximize is ignored', () => {
    const h = harness()
    h.store.merge(MAIN_WINDOW, 's1')
    expect(h.store.merge(MAIN_WINDOW, 's2')).toBe(false)
    expect(h.store.promote('a')).toBe(false)
    expect(h.store.getSnapshot()).toHaveLength(1)
  })

  it('needs a split', () => {
    const doc = buildDocument([add('x', { to: 'stack', dock: main, stackId: 'only' })])
    expect(harness(doc).store.merge(MAIN_WINDOW, 'only')).toBe(false)
  })

  it('materializes into one stack in the drawn order', () => {
    const h = harness()
    h.store.merge(MAIN_WINDOW, 's2')
    let doc = h.doc
    for (const change of materialize(doc, MAIN_WINDOW, h.store.getSnapshot())) doc = apply(doc, change)
    expect(doc.windows[MAIN_WINDOW].dock).toEqual({ kind: 'stack', id: 's2', panels: ['cv', 'p1', 'p3'] })
  })
})

describe('promote (maximize a canvas pane)', () => {
  it('draws the pane as a tab after its canvas and leaves it out of the node', () => {
    const h = harness()
    expect(h.store.promote('a')).toBe(true)
    const list = h.store.getSnapshot()
    expect(dockPanels(presentedWindowDock(h.doc, MAIN_WINDOW, list))).toEqual(['cv', 'a', 'p1', 'p3'])
    expect(dockPanels(presentedNodeDock(h.doc, 'C', 'N1', list))).toEqual(['b'])
    expect(promotedPanels(list)).toEqual(new Set(['a']))
    expect(h.shown).toEqual([['s1', 'a']])
  })

  it('a singleton node disappears from the canvas while promoted', () => {
    const h = harness()
    h.store.promote('solo')
    expect(presentedNodeDock(h.doc, 'C', 'N2', h.store.getSnapshot())).toBeNull()
  })

  it('restores the exact node when both sides are unchanged', () => {
    const h = harness()
    h.store.promote('a')
    h.change({ kind: 'setSplitRatio', splitId: 'sp', ratios: [0.4, 0.6] })
    const [presentation] = h.store.getSnapshot()
    expect(h.store.restore(presentation)).toBe(true)
    expect(dockPanels(presentedNodeDock(h.doc, 'C', 'N1', []))).toEqual(['a', 'b'])
  })

  it('several panes promote independently', () => {
    const h = harness()
    h.store.promote('a')
    h.store.promote('solo')
    const [first, second] = h.store.getSnapshot()
    expect(h.store.getSnapshot()).toHaveLength(2)
    expect(h.store.restore(second)).toBe(true)
    expect(h.store.getSnapshot()).toEqual([first])
  })

  it('is consumed when the source node changes structurally', () => {
    const h = harness()
    h.store.promote('a')
    h.change({ kind: 'removePanels', ids: ['b'] })
    expect(h.store.getSnapshot()).toEqual([])
  })

  it('is consumed when the destination dock changes structurally', () => {
    const h = harness()
    h.store.promote('a')
    h.change(add('new', { to: 'stack', dock: main, stackId: 's2' }))
    expect(h.store.getSnapshot()).toEqual([])
  })

  it('materializes as a real tab after the canvas', () => {
    const h = harness()
    h.store.promote('a')
    let doc = h.doc
    for (const change of materialize(doc, MAIN_WINDOW, h.store.getSnapshot())) doc = apply(doc, change)
    expect(dockPanels(doc.windows[MAIN_WINDOW].dock)).toEqual(['cv', 'a', 'p1', 'p3'])
    expect(dockPanels(dockOf(doc, node))).toEqual(['b'])
  })
})
