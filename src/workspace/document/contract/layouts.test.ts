// Layouts: a host (a window or a canvas node) holds several dock trees; every
// panel is in exactly one, and a layout can move to another host.

import { describe, expect, it } from 'vitest'
import { applyOp } from './apply'
import { invertOp } from './invert'
import type { DocChange, DockRef, LayoutTarget, PlaceTarget } from './ops'
import { placementOf } from './placement'
import { createDocument, MAIN_WINDOW, type PanelType, type WorkspaceDocument } from './schema'
import { DOCUMENT_FILE_VERSION, parseDocument, validateDocument } from './serialize'
import { layoutOf, panelsInLayout, panelsInWindow, windowDock } from './selectors'

type Doc = WorkspaceDocument

const L1: DockRef = { layoutId: 'main' }
const L2: DockRef = { layoutId: 'two' }

function ok(doc: Doc, ...changes: DocChange[]): Doc {
  for (const change of changes) {
    const result = applyOp(doc, change)
    if (result.error) throw new Error(`${change.kind}: ${result.error.code} ${result.error.message}`)
    expect(validateDocument(result.doc)).toBeNull()
    doc = result.doc
  }
  return doc
}

const record = (id: string, type: PanelType = 'terminal') => ({ id, type, title: id, fields: {} })
const add = (id: string, at: PlaceTarget): DocChange => ({ kind: 'addPanel', record: record(id), at })
const tab = (dock: DockRef, stackId: string, after?: string | null): PlaceTarget => ({ to: 'stack', dock, stackId, after })
const addLayout = (layoutId: string, name?: string, index?: number): DocChange => ({ kind: 'addLayout', host: { windowId: MAIN_WINDOW }, layoutId, name, index })
const toIndex = (index: number): LayoutTarget => ({ to: 'host', host: { windowId: MAIN_WINDOW }, index })
const layoutsOf = (doc: Doc) => doc.windows[MAIN_WINDOW].layouts.map((l) => l.id)

/** layouts main [a, b] and two [c] */
function twoLayouts(): Doc {
  return ok(createDocument(), add('a', tab(L1, 's1')), add('b', tab(L1, 's1')), addLayout('two'), add('c', tab(L2, 's2')))
}

describe('layouts', () => {
  it('a new window has one empty layout; addLayout appends an empty one', () => {
    const doc = ok(createDocument(), addLayout('two', 'Build'))
    expect(doc.windows[MAIN_WINDOW].layouts).toEqual([{ id: 'main', name: 'Layout 1', dock: null }, { id: 'two', name: 'Build', dock: null }])
  })

  it('a panel placed in a layout is in exactly that dock', () => {
    const doc = twoLayouts()
    expect(placementOf(doc, 'a')?.dock).toEqual(L1)
    expect(placementOf(doc, 'c')?.dock).toEqual(L2)
    expect(layoutOf(doc, 'c')).toEqual({ windowId: MAIN_WINDOW, layoutId: 'two' })
    expect(panelsInLayout(doc, 'main')).toEqual(['a', 'b'])
    expect(panelsInWindow(doc, MAIN_WINDOW).sort()).toEqual(['a', 'b', 'c'])
  })

  it('moving a panel between layouts keeps it in one dock', () => {
    const doc = ok(twoLayouts(), { kind: 'placePanel', id: 'a', at: tab(L2, 's2') })
    expect(placementOf(doc, 'a')?.dock).toEqual(L2)
    expect(panelsInLayout(doc, 'main')).toEqual(['b'])
  })

  it('a window layout that empties is dropped, unless it is the only one', () => {
    const doc = ok(twoLayouts(), { kind: 'removePanels', ids: ['c'] })
    expect(layoutsOf(doc)).toEqual(['main'])
    // Pulling the last panel out of a layout does the same.
    const moved = ok(twoLayouts(), { kind: 'placePanel', id: 'c', at: tab(L1, 's1') })
    expect(layoutsOf(moved)).toEqual(['main'])
    expect(placementOf(moved, 'c')?.dock).toEqual(L1)
    // The sole layout stays, empty: the main window offers its creation menu.
    const emptied = ok(ok(doc, { kind: 'removePanels', ids: ['a', 'b'] }))
    expect(emptied.windows[MAIN_WINDOW].layouts).toEqual([{ id: 'main', name: 'Layout 1', dock: null }])
  })

  it('to:tab puts a panel in a new layout at an index; undo restores the old one', () => {
    const at = (index?: number): PlaceTarget => ({ to: 'tab', host: { windowId: MAIN_WINDOW }, layoutId: 'new', stackId: 'sn', index })
    const doc = ok(twoLayouts(), { kind: 'placePanel', id: 'a', at: at(0) })
    expect(layoutsOf(doc)).toEqual(['new', 'main', 'two'])
    expect(placementOf(doc, 'a')?.dock).toEqual({ layoutId: 'new' })
    const added = ok(twoLayouts(), add('d', at()))
    expect(layoutsOf(added)).toEqual(['main', 'two', 'new'])
    expect(layoutsOf(ok(added, ...invertOp(twoLayouts(), add('d', at()), () => 'fresh')))).toEqual(['main', 'two'])
    // A lone panel of the sole layout moving to a new tab leaves no empty layout behind.
    const sole = ok(createDocument(), add('x', tab(L1, 'sx')), { kind: 'placePanel', id: 'x', at: at() })
    expect(layoutsOf(sole)).toEqual(['new'])
  })

  it('removeLayout takes its panels with it and keeps at least one layout', () => {
    const doc = ok(twoLayouts(), { kind: 'removeLayout', layoutId: 'two' })
    expect(layoutsOf(doc)).toEqual(['main'])
    expect(doc.panels.c).toBeUndefined()
    const result = applyOp(doc, { kind: 'removeLayout', layoutId: 'main' })
    expect(result.error?.code).toBe('rejected')
  })

  it('rejects a duplicate layout id and a placement into a missing layout', () => {
    const doc = twoLayouts()
    expect(applyOp(doc, addLayout('two')).error?.code).toBe('rejected')
    expect(applyOp(doc, add('z', tab({ layoutId: 'nope' }, 's9'))).error?.code).toBe('gone')
  })

  it('layouts are named at creation and keep the name when moved or when others go', () => {
    const doc = ok(createDocument(), addLayout('b'), addLayout('c'))
    const names = (d: Doc) => d.windows[MAIN_WINDOW].layouts.map((l) => `${l.id}:${l.name}`)
    expect(names(doc)).toEqual(['main:Layout 1', 'b:Layout 2', 'c:Layout 3'])
    expect(names(ok(doc, { kind: 'moveLayout', layoutId: 'c', to: toIndex(0) }))).toEqual(['c:Layout 3', 'main:Layout 1', 'b:Layout 2'])
    // A later layout never takes a name that is still in use.
    expect(names(ok(doc, { kind: 'removeLayout', layoutId: 'b' }, addLayout('d')))).toEqual(['main:Layout 1', 'c:Layout 3', 'd:Layout 4'])
  })

  it('moveLayout reorders, clamps, and undoes', () => {
    const before = ok(twoLayouts(), addLayout('three'))
    const change: DocChange = { kind: 'moveLayout', layoutId: 'three', to: toIndex(0) }
    const after = ok(before, change)
    expect(layoutsOf(after)).toEqual(['three', 'main', 'two'])
    expect(layoutsOf(ok(before, { kind: 'moveLayout', layoutId: 'main', to: toIndex(99) }))).toEqual(['two', 'three', 'main'])
    expect(layoutsOf(ok(after, ...invertOp(before, change, () => 'fresh')))).toEqual(['main', 'two', 'three'])
  })

  it('renameLayout sets and clears the name', () => {
    const named = ok(twoLayouts(), { kind: 'renameLayout', layoutId: 'two', name: 'Logs' })
    expect(named.windows[MAIN_WINDOW].layouts[1].name).toBe('Logs')
    expect(applyOp(named, { kind: 'renameLayout', layoutId: 'two', name: '  ' }).error?.code).toBe('rejected')
  })

  it('a detached window is removed with its last panel across all layouts', () => {
    let doc = ok(createDocument(), add('a', tab(L1, 's1')), add('w', { to: 'window', windowId: 'W', layoutId: 'W-main', stackId: 'sw' }))
    doc = ok(doc, { kind: 'addLayout', host: { windowId: 'W' }, layoutId: 'wb' }, add('v', tab({ layoutId: 'wb' }, 'sv')))
    expect(doc.windows.W.layouts.map((l) => l.id)).toEqual(['W-main', 'wb'])
    doc = ok(doc, { kind: 'removePanels', ids: ['w'] })
    expect(doc.windows.W.layouts.map((l) => [l.id, l.dock === null])).toEqual([['wb', false]])
    doc = ok(doc, { kind: 'removePanels', ids: ['v'] })
    expect(doc.windows.W).toBeUndefined()
  })

  it('windowDock prefers the named layout, else the first', () => {
    const doc = twoLayouts()
    expect(windowDock(doc, MAIN_WINDOW, 'two')).toEqual(L2)
    expect(windowDock(doc, MAIN_WINDOW, 'gone')).toEqual(L1)
    expect(windowDock(doc, MAIN_WINDOW)).toEqual(L1)
  })

  it('undo of removeLayout brings the layout, its name and its panels back at the same spot', () => {
    const before = ok(twoLayouts(), { kind: 'renameLayout', layoutId: 'two', name: 'Logs' }, addLayout('three'))
    const change: DocChange = { kind: 'removeLayout', layoutId: 'two' }
    const after = ok(before, change)
    const undone = ok(after, ...invertOp(before, change, () => 'fresh'))
    expect(layoutsOf(undone)).toEqual(['main', 'two', 'three'])
    expect(undone.windows[MAIN_WINDOW].layouts[1].name).toBe('Logs')
    expect(placementOf(undone, 'c')?.dock).toEqual(L2)
  })

  it('survives a save and load', () => {
    const doc = ok(twoLayouts(), { kind: 'renameLayout', layoutId: 'two', name: 'Logs' })
    const parsed = parseDocument(JSON.stringify({ version: DOCUMENT_FILE_VERSION, document: doc }))
    expect(parsed.ok && parsed.doc).toEqual(doc)
  })

  it('a malformed layout list is not a valid document', () => {
    const doc = twoLayouts()
    const noLayouts = { ...doc, windows: { main: { ...doc.windows.main, layouts: [] } } }
    expect(validateDocument(noLayouts)).toMatch(/needs a layout/)
    const dup = { ...doc, windows: { main: { ...doc.windows.main, layouts: [doc.windows.main.layouts[0], doc.windows.main.layouts[0]] } } }
    expect(validateDocument(dup)).not.toBeNull()
  })

  describe('moving a layout between hosts', () => {
    const R = { origin: { x: 0, y: 0 }, size: { width: 300, height: 200 } }
    /** main [a, b] and two [c], plus a canvas panel `cv` (canvas `c1`) in main. */
    const withCanvas = () => ok(twoLayouts(), { kind: 'addPanel', record: { ...record('cv', 'canvas'), canvasId: 'c1' }, at: tab(L1, 's1') })
    const toWindow = (layoutId: string, windowId = 'W'): DocChange => ({ kind: 'moveLayout', layoutId, to: { to: 'window', windowId } })
    const toNode = (layoutId: string, nodeId = 'n1'): DocChange => ({ kind: 'moveLayout', layoutId, to: { to: 'canvas', canvasId: 'c1', nodeId, rect: R } })

    it('a layout moves into a new window, and the window goes with its last layout back', () => {
      let doc = ok(twoLayouts(), toWindow('two'))
      expect(layoutsOf(doc)).toEqual(['main'])
      expect(doc.windows.W).toMatchObject({ kind: 'detached', layouts: [{ id: 'two', name: 'Layout 2' }] })
      expect(placementOf(doc, 'c')?.dock).toEqual(L2)
      expect(layoutOf(doc, 'c')).toEqual({ windowId: 'W', layoutId: 'two' })
      doc = ok(doc, { kind: 'moveLayout', layoutId: 'two', to: toIndex(1) })
      expect(layoutsOf(doc)).toEqual(['main', 'two'])
      expect(doc.windows.W).toBeUndefined()
    })

    it('a layout moves onto a canvas as a new node and back', () => {
      let doc = ok(withCanvas(), toNode('two'))
      expect(doc.canvases.c1.nodes.n1.layouts.map((l) => l.id)).toEqual(['two'])
      expect(layoutsOf(doc)).toEqual(['main'])
      expect(layoutOf(doc, 'c')).toEqual({ windowId: MAIN_WINDOW, layoutId: 'main' })
      expect(panelsInLayout(doc, 'main')).toEqual(['a', 'b', 'cv', 'c'])
      doc = ok(doc, { kind: 'moveLayout', layoutId: 'two', to: toIndex(1) })
      expect(doc.canvases.c1.nodes.n1).toBeUndefined()
    })

    it('a node can hold several layouts; it goes when only empty ones are left', () => {
      let doc = ok(withCanvas(), toNode('two'), { kind: 'addLayout', host: { canvasId: 'c1', nodeId: 'n1' }, layoutId: 'extra' })
      expect(doc.canvases.c1.nodes.n1.layouts.map((l) => l.id)).toEqual(['two', 'extra'])
      doc = ok(doc, { kind: 'removePanels', ids: ['c'] })
      expect(doc.canvases.c1.nodes.n1).toBeUndefined()
    })

    it('the main window keeps its last layout, and a layout with a canvas panel stays off canvases', () => {
      const doc = withCanvas()
      expect(applyOp(ok(createDocument(), add('a', tab(L1, 's1'))), toWindow('main')).error?.code).toBe('rejected')
      expect(applyOp(doc, toNode('main')).error?.code).toBe('rejected')
      const other = ok(doc, { kind: 'placePanel', id: 'cv', at: tab(L2, 's2') })
      expect(applyOp(other, toNode('two')).error?.code).toBe('rejected')
      expect(applyOp(doc, add('x', { to: 'stack', dock: { layoutId: 'two' }, stackId: 's2' })).error).toBeUndefined()
    })

    it('a new host needs a layout with panels and free ids', () => {
      const doc = ok(withCanvas(), addLayout('empty'))
      expect(applyOp(doc, toWindow('empty')).error?.code).toBe('rejected')
      expect(applyOp(doc, toWindow('two', 'main')).error?.code).toBe('rejected')
      expect(applyOp(doc, { kind: 'moveLayout', layoutId: 'two', to: { to: 'canvas', canvasId: 'nope', nodeId: 'n', rect: R } }).error?.code).toBe('gone')
      expect(applyOp(doc, { kind: 'moveLayout', layoutId: 'nope', to: toIndex(0) }).error?.code).toBe('gone')
    })

    it('a layout moves into an existing node or window at an index', () => {
      let doc = ok(withCanvas(), toNode('two'))
      doc = ok(doc, addLayout('three'), add('d', tab({ layoutId: 'three' }, 's3')))
      doc = ok(doc, { kind: 'moveLayout', layoutId: 'three', to: { to: 'host', host: { canvasId: 'c1', nodeId: 'n1' }, index: 0 } })
      expect(doc.canvases.c1.nodes.n1.layouts.map((l) => l.id)).toEqual(['three', 'two'])
      expect(applyOp(doc, { kind: 'moveLayout', layoutId: 'three', to: { to: 'host', host: { windowId: 'nope' } } }).error?.code).toBe('gone')
    })

    it('undo puts a layout back in its old host at its old spot, recreating the host it emptied', () => {
      const before = ok(withCanvas(), toNode('two'), addLayout('three'))
      const moveOut: DocChange = { kind: 'moveLayout', layoutId: 'two', to: toIndex(0) }
      const after = ok(before, moveOut)
      expect(after.canvases.c1.nodes.n1).toBeUndefined()
      const undone = ok(after, ...invertOp(before, moveOut, () => 'fresh'))
      expect(undone.canvases.c1.nodes.n1.layouts.map((l) => l.id)).toEqual(['two'])
      expect(undone.canvases.c1.nodes.n1.rect).toEqual(R)
      expect(layoutsOf(undone)).toEqual(['main', 'three'])

      const win = ok(twoLayouts(), toWindow('two'))
      const back: DocChange = { kind: 'moveLayout', layoutId: 'two', to: toIndex(1) }
      const undoneWin = ok(ok(win, back), ...invertOp(win, back, () => 'fresh'))
      expect(undoneWin.windows.W.layouts.map((l) => l.id)).toEqual(['two'])
    })

    it('survives a save and load', () => {
      const doc = ok(withCanvas(), toNode('two'))
      const parsed = parseDocument(JSON.stringify({ version: DOCUMENT_FILE_VERSION, document: doc }))
      expect(parsed.ok && parsed.doc).toEqual(doc)
    })
  })
})
