import { describe, expect, it } from 'vitest'
import { applyOp, createDocument, MAIN_WINDOW, type DocBatch, type DocChange, type WorkspaceDocument } from '@workspace/document/contract'
import { panelDefinition } from '@panels/definitions'
import { addRelation, relationTargets, removeRelation, setRelationContextMode, updateRelationMeaning, type RelationDocument } from './edits'
import { forgetRelationLabel, labelRelation, rememberRelationLabel, renameRelationLabel, type RelationLabelLibrary } from './labels'

const roleOf = (type: string) => panelDefinition(type)?.relation

function storeWith(...ids: string[]): RelationDocument & { doc: WorkspaceDocument } {
  const store = {
    doc: createDocument(),
    getSnapshot: () => store.doc,
    propose(change: DocChange | DocBatch) {
      const result = applyOp(store.doc, change)
      if (result.error) return { ok: false }
      store.doc = result.doc
      return { ok: true }
    },
  }
  for (const id of ids) {
    store.propose({
      kind: 'addPanel',
      record: { id, type: id.startsWith('surface') ? 'surface' : 'terminal', title: id, fields: {} },
      at: { to: 'stack', dock: { windowId: MAIN_WINDOW }, stackId: 's1' },
    })
  }
  return store
}

describe('relation edits', () => {
  it('adds a relation, then re-points it for the same pair', () => {
    const store = storeWith('a', 'b')
    const id = addRelation(store, roleOf, 'a', 'b', 'context')
    expect(id).not.toBeNull()
    expect(addRelation(store, roleOf, 'a', 'b', 'verify')).toBe(id)
    expect(Object.values(store.doc.relations)).toEqual([{ id, fromPanelId: 'a', toPanelId: 'b', kind: 'verify' }])
  })

  it('refuses a panel relating to itself or to a missing panel', () => {
    const store = storeWith('a')
    expect(addRelation(store, roleOf, 'a', 'a', 'use')).toBeNull()
    expect(addRelation(store, roleOf, 'a', 'gone', 'use')).toBeNull()
  })

  it('changes the meaning, removes, and sets the context mode', () => {
    const store = storeWith('a', 'b')
    const id = addRelation(store, roleOf, 'a', 'b', 'context')!
    expect(updateRelationMeaning(store, id, 'use', ' Mine ')).toBe(true)
    expect(store.doc.relations[id]).toMatchObject({ kind: 'use', label: 'Mine' })
    expect(setRelationContextMode(store, 'a', 'always')).toBe(true)
    expect(store.doc.panels.a.fields.relationContextMode).toBe('always')
    expect(removeRelation(store, id)).toBe(true)
    expect(store.doc.relations).toEqual({})
  })

  it('offers every other panel that closes no cycle', () => {
    const store = storeWith('a', 'b', 'c')
    addRelation(store, roleOf, 'a', 'b', 'use')
    addRelation(store, roleOf, 'b', 'c', 'use')
    expect(relationTargets(store.doc, 'c', roleOf).map((p) => p.id)).toEqual([])
    expect(relationTargets(store.doc, 'a', roleOf).map((p) => p.id)).toEqual(['b', 'c'])
  })

  it('leaves out panels without a relation role', () => {
    const store = storeWith('a', 'b', 'surface')
    expect(relationTargets(store.doc, 'a', roleOf).map((p) => p.id)).toEqual(['b'])
    expect(relationTargets(store.doc, 'surface', roleOf)).toEqual([])
    expect(addRelation(store, roleOf, 'a', 'surface', 'context')).toBeNull()
    expect(addRelation(store, roleOf, 'surface', 'a', 'context')).toBeNull()
  })
})

describe('relation labels', () => {
  const libraryOf = (...labels: string[]): RelationLabelLibrary & { labels: string[] } => {
    const library = { labels, get: () => library.labels, set: (next: string[]) => { library.labels = next } }
    return library
  }

  it('labels a relation in its own words, the kind kept', () => {
    const store = storeWith('a', 'b')
    const id = addRelation(store, roleOf, 'a', 'b', 'verify')!
    expect(labelRelation(store, id, '  summarizes for ')).toBe(true)
    expect(store.doc.relations[id]).toMatchObject({ kind: 'verify', label: 'summarizes for' })
    expect(labelRelation(store, id, '   ')).toBe(false)
    expect(labelRelation(store, 'gone', 'words')).toBe(false)
  })

  it('remembers a label first and once, renames in place, forgets', () => {
    const library = libraryOf('reviews', 'feeds')
    rememberRelationLabel(library, 'Feeds')
    expect(library.labels).toEqual(['Feeds', 'reviews'])
    renameRelationLabel(library, 'reviews', 'feeds')
    expect(library.labels).toEqual(['Feeds'])
    renameRelationLabel(library, 'Feeds', '  ')
    expect(library.labels).toEqual(['Feeds'])
    forgetRelationLabel(library, 'Feeds')
    expect(library.labels).toEqual([])
  })
})
