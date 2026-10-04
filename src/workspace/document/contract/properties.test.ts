// Property tests over seeded random changes: every applied change keeps the
// document valid and never mutates its input, and its inverse restores the
// document it applied to.

import { describe, expect, it } from 'vitest'
import { applyOp } from './apply'
import { applicable, invertOp } from './invert'
import { createRng, randomChange } from './fuzz'
import { createDocument, type WorkspaceDocument } from './schema'
import { validateDocument } from './serialize'
import { placementOf } from './placement'
import type { DocChange } from './ops'

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value)) deepFreeze(v)
  }
  return value
}

function run(seed: number, steps: number, onStep: (before: WorkspaceDocument, change: DocChange, after: WorkspaceDocument, ok: boolean) => void) {
  const rng = createRng(seed)
  let n = 0
  const newId = () => `${seed}-${++n}`
  let doc = deepFreeze(createDocument())
  for (let i = 0; i < steps; i++) {
    const change = randomChange(doc, rng, newId)
    const result = applyOp(doc, change)
    onStep(doc, change, result.doc, !result.error)
    if (!result.error) doc = deepFreeze(result.doc)
  }
  return doc
}

function placements(doc: WorkspaceDocument) {
  return Object.fromEntries(Object.keys(doc.panels).map((id) => [id, placementOf(doc, id)]))
}

function withoutTrees(doc: WorkspaceDocument) {
  return {
    ...doc,
    windows: Object.fromEntries(Object.entries(doc.windows).map(([id, w]) => [id, { ...w, dock: null }])),
    canvases: Object.fromEntries(Object.entries(doc.canvases).map(([id, c]) => [id, {
      ...c,
      nodes: Object.fromEntries(Object.entries(c.nodes).map(([nodeId, n]) => [nodeId, { ...n, dock: null }])),
    }])),
  }
}

/** Key order is not state: compare with sorted keys. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted((value as Record<string, unknown>)[key])]))
  }
  return value
}

describe('random changes', () => {
  it('keep the document valid, fail without changes, and never mutate the input', () => {
    let applied = 0
    let failed = 0
    for (let seed = 1; seed <= 40; seed++) {
      run(seed, 150, (before, change, after, ok) => {
        if (ok) {
          applied++
          const problem = validateDocument(after)
          if (problem) throw new Error(`${problem} after ${JSON.stringify(change)}`)
        } else {
          failed++
          expect(after).toBe(before)
        }
      })
    }
    expect(applied).toBeGreaterThan(2000)
    expect(failed).toBeGreaterThan(200)
  })

  // A removal can collapse two levels of splits into their grandparent; one
  // split target cannot regroup those siblings, so the inverse restores
  // every tab to its stack but may flatten that part of the tree.
  it('are undone by their inverse: every tab back in its stack, the tree nearly always exact', () => {
    let checked = 0
    let exact = 0
    for (let seed = 100; seed <= 140; seed++) {
      let n = 0
      const newId = () => `undo-${seed}-${++n}`
      run(seed, 120, (before, change, after, ok) => {
        if (!ok) return
        const inverse = invertOp(before, change, newId)
        const undone = applyOp(after, { kind: 'batch', changes: inverse })
        if (undone.error) throw new Error(`inverse of ${JSON.stringify(change)} failed: ${undone.error.message}`)
        expect(withoutTrees(undone.doc), JSON.stringify(change)).toEqual(withoutTrees(before))
        expect(placements(undone.doc), JSON.stringify(change)).toEqual(placements(before))
        expect(applicable(after, inverse)).toEqual(inverse)
        if (JSON.stringify(sorted(undone.doc)) === JSON.stringify(sorted(before))) exact++
        checked++
      })
    }
    expect(checked).toBeGreaterThan(2000)
    expect(exact / checked).toBeGreaterThan(0.995)
  })
})
