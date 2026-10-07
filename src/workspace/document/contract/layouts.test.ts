// Layouts: a window holds several dock trees; every panel is in exactly one.

import { describe, expect, it } from 'vitest'
import { applyOp } from './apply'
import { invertOp } from './invert'
import type { DocChange, DockRef, PlaceTarget } from './ops'
import { placementOf } from './placement'
import { createDocument, MAIN_WINDOW, type PanelType, type WorkspaceDocument } from './schema'
import { serializeDocument, parseDocument, validateDocument } from './serialize'
import { layoutOf, panelsInLayout, panelsInWindow, windowDock } from './selectors'

type Doc = WorkspaceDocument

const L1: DockRef = { windowId: MAIN_WINDOW, layoutId: 'main' }
const L2: DockRef = { windowId: MAIN_WINDOW, layoutId: 'two' }

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
const addLayout = (layoutId: string, name?: string, index?: number): DocChange => ({ kind: 'addLayout', windowId: MAIN_WINDOW, layoutId, name, index })
const layoutsOf = (doc: Doc) => doc.windows[MAIN_WINDOW].layouts.map((l) => l.id)

/** layouts main [a, b] and two [c] */
function twoLayouts(): Doc {
  return ok(createDocument(), add('a', tab(L1, 's1')), add('b', tab(L1, 's1')), addLayout('two'), add('c', tab(L2, 's2')))
}

describe('layouts', () => {
  it('a new window has one empty layout; addLayout appends an empty one', () => {
    const doc = ok(createDocument(), addLayout('two', 'Build'))
    expect(doc.windows[MAIN_WINDOW].layouts).toEqual([{ id: 'main', dock: null }, { id: 'two', name: 'Build', dock: null }])
  })

  it('a panel placed in a layout is in exactly that dock', () => {
    const doc = twoLayouts()
    expect(placementOf(doc, 'a')?.dock).toEqual(L1)
    expect(placementOf(doc, 'c')?.dock).toEqual(L2)
    expect(layoutOf(doc, 'c')).toEqual({ windowId: MAIN_WINDOW, layoutId: 'two' })
    expect(panelsInLayout(doc, MAIN_WINDOW, 'main')).toEqual(['a', 'b'])
    expect(panelsInWindow(doc, MAIN_WINDOW).sort()).toEqual(['a', 'b', 'c'])
  })

  it('moving a panel between layouts keeps it in one dock', () => {
    const doc = ok(twoLayouts(), { kind: 'placePanel', id: 'a', at: tab(L2, 's2') })
    expect(placementOf(doc, 'a')?.dock).toEqual(L2)
    expect(panelsInLayout(doc, MAIN_WINDOW, 'main')).toEqual(['b'])
  })

  it('a layout that empties is removed, unless it is the window\'s only one', () => {
    const doc = ok(twoLayouts(), { kind: 'removePanels', ids: ['c'] })
    expect(layoutsOf(doc)).toEqual(['main'])
    const only = ok(doc, { kind: 'removePanels', ids: ['a', 'b'] })
    expect(layoutsOf(only)).toEqual(['main'])
    expect(only.windows[MAIN_WINDOW].layouts[0].dock).toBeNull()
  })

  it('removeLayout takes its panels with it and keeps at least one layout', () => {
    const doc = ok(twoLayouts(), { kind: 'removeLayout', windowId: MAIN_WINDOW, layoutId: 'two' })
    expect(layoutsOf(doc)).toEqual(['main'])
    expect(doc.panels.c).toBeUndefined()
    const result = applyOp(doc, { kind: 'removeLayout', windowId: MAIN_WINDOW, layoutId: 'main' })
    expect(result.error?.code).toBe('rejected')
  })

  it('rejects a duplicate layout id and a placement into a missing layout', () => {
    const doc = twoLayouts()
    expect(applyOp(doc, addLayout('two')).error?.code).toBe('rejected')
    expect(applyOp(doc, add('z', tab({ windowId: MAIN_WINDOW, layoutId: 'nope' }, 's9'))).error?.code).toBe('gone')
  })

  it('renameLayout sets and clears the name', () => {
    const named = ok(twoLayouts(), { kind: 'renameLayout', windowId: MAIN_WINDOW, layoutId: 'two', name: 'Logs' })
    expect(named.windows[MAIN_WINDOW].layouts[1].name).toBe('Logs')
    const cleared = ok(named, { kind: 'renameLayout', windowId: MAIN_WINDOW, layoutId: 'two', name: null })
    expect(cleared.windows[MAIN_WINDOW].layouts[1]).toEqual({ id: 'two', dock: expect.anything() })
  })

  it('a detached window is removed with its last panel across all layouts', () => {
    let doc = ok(createDocument(), add('a', tab(L1, 's1')), add('w', { to: 'window', windowId: 'W', layoutId: 'main', stackId: 'sw' }))
    doc = ok(doc, { kind: 'addLayout', windowId: 'W', layoutId: 'wb' }, add('v', tab({ windowId: 'W', layoutId: 'wb' }, 'sv')))
    expect(doc.windows.W.layouts.map((l) => l.id)).toEqual(['main', 'wb'])
    doc = ok(doc, { kind: 'removePanels', ids: ['w'] })
    expect(doc.windows.W.layouts.map((l) => l.id)).toEqual(['wb'])
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
    const before = ok(twoLayouts(), { kind: 'renameLayout', windowId: MAIN_WINDOW, layoutId: 'two', name: 'Logs' }, addLayout('three'))
    const change: DocChange = { kind: 'removeLayout', windowId: MAIN_WINDOW, layoutId: 'two' }
    const after = ok(before, change)
    const undone = ok(after, ...invertOp(before, change, () => 'fresh'))
    expect(layoutsOf(undone)).toEqual(['main', 'two', 'three'])
    expect(undone.windows[MAIN_WINDOW].layouts[1].name).toBe('Logs')
    expect(placementOf(undone, 'c')?.dock).toEqual(L2)
  })

  it('survives a save and load', () => {
    const doc = ok(twoLayouts(), { kind: 'renameLayout', windowId: MAIN_WINDOW, layoutId: 'two', name: 'Logs' })
    const parsed = parseDocument(serializeDocument(doc))
    expect(parsed.ok && parsed.doc).toEqual(doc)
  })

  it('a malformed layout list is not a valid document', () => {
    const doc = twoLayouts()
    const noLayouts = { ...doc, windows: { main: { ...doc.windows.main, layouts: [] } } }
    expect(validateDocument(noLayouts)).toMatch(/needs a layout/)
    const dup = { ...doc, windows: { main: { ...doc.windows.main, layouts: [doc.windows.main.layouts[0], doc.windows.main.layouts[0]] } } }
    expect(validateDocument(dup)).not.toBeNull()
  })
})
