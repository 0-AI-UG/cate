import { describe, expect, it } from 'vitest'
import { applyOp, createDocument, MAIN_WINDOW, type DocBatch, type DocChange, type WorkspaceDocument } from '@workspace/document/contract'
import { addRelation, relationTargets, removeRelation, setRelationContextMode, updateRelationMeaning, type RelationDocument } from './edits'

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
      record: { id, type: 'terminal', title: id, fields: {} },
      at: { to: 'stack', dock: { windowId: MAIN_WINDOW }, stackId: 's1' },
    })
  }
  return store
}

describe('relation edits', () => {
  it('adds a relation, then re-points it for the same pair', () => {
    const store = storeWith('a', 'b')
    const id = addRelation(store, 'a', 'b', 'context')
    expect(id).not.toBeNull()
    expect(addRelation(store, 'a', 'b', 'verify')).toBe(id)
    expect(Object.values(store.doc.relations)).toEqual([{ id, fromPanelId: 'a', toPanelId: 'b', kind: 'verify' }])
  })

  it('refuses a panel relating to itself or to a missing panel', () => {
    const store = storeWith('a')
    expect(addRelation(store, 'a', 'a', 'use')).toBeNull()
    expect(addRelation(store, 'a', 'gone', 'use')).toBeNull()
  })

  it('changes the meaning, removes, and sets the context mode', () => {
    const store = storeWith('a', 'b')
    const id = addRelation(store, 'a', 'b', 'context')!
    expect(updateRelationMeaning(store, id, 'use', ' Mine ')).toBe(true)
    expect(store.doc.relations[id]).toMatchObject({ kind: 'use', label: 'Mine' })
    expect(setRelationContextMode(store, 'a', 'always')).toBe(true)
    expect(store.doc.panels.a.fields.relationContextMode).toBe('always')
    expect(removeRelation(store, id)).toBe(true)
    expect(store.doc.relations).toEqual({})
  })

  it('offers every other panel that closes no cycle', () => {
    const store = storeWith('a', 'b', 'c')
    addRelation(store, 'a', 'b', 'use')
    addRelation(store, 'b', 'c', 'use')
    expect(relationTargets(store.doc, 'c').map((p) => p.id)).toEqual([])
    expect(relationTargets(store.doc, 'a').map((p) => p.id)).toEqual(['b', 'c'])
  })
})
