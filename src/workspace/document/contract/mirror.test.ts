import { describe, expect, it } from 'vitest'
import { createMirror } from './mirror'
import type { DocChange, DocOp } from './ops'
import { createDocument } from './schema'
import { createSequencer } from './sequencer'

const addA: DocChange = { kind: 'addPanel', record: { id: 'a', type: 'terminal', title: 'a', fields: {} }, at: { to: 'stack', dock: { windowId: 'main', layoutId: 'main' }, stackId: 's1' } }
const op = (clientId: string, counter: number, change: DocChange): DocOp => ({ ...change, opId: { clientId, counter } })
const rename = (title: string): DocChange => ({ kind: 'updatePanel', id: 'a', patch: { title } })

describe('createSequencer', () => {
  it('numbers applied ops and applies each opId once', () => {
    const runtime = createSequencer({ doc: createDocument() })
    expect(runtime.submit(op('c1', 1, addA))).toEqual({ status: 'applied', seq: 1 })
    expect(runtime.submit(op('c1', 1, addA))).toEqual({ status: 'duplicate' })
    expect(runtime.submit(op('c2', 1, addA))).toMatchObject({ status: 'failed', error: { code: 'rejected' } })
    expect(runtime.submit(op('c2', 1, rename('x')))).toEqual({ status: 'duplicate' })
    expect(runtime.submit(op('c2', 2, rename('x')))).toEqual({ status: 'applied', seq: 2 })
    expect(runtime.seq).toBe(2)
    expect([...runtime.counters]).toEqual([['c1', 1], ['c2', 2]])
    expect(runtime.doc.panels.a.title).toBe('x')
    expect(runtime.submit({ ...rename('y'), opId: { clientId: '', counter: 3 } })).toMatchObject({ status: 'failed' })
    expect(runtime.submit({ ...rename('y'), opId: { clientId: 'c3', counter: 0 } })).toMatchObject({ status: 'failed' })
  })

  it('replays what a client missed while it is kept, and asks for the full document after', () => {
    const runtime = createSequencer({ doc: createDocument(), keep: 3 })
    runtime.submit(op('c', 1, addA))
    for (let i = 2; i <= 6; i++) runtime.submit(op('c', i, rename(`t${i}`)))
    expect(runtime.since(6)).toEqual([])
    expect(runtime.since(4)?.map((e) => e.seq)).toEqual([5, 6])
    expect(runtime.since(3)?.map((e) => e.seq)).toEqual([4, 5, 6])
    expect(runtime.since(2)).toBeNull()
    expect(runtime.since(7)).toBeNull()
  })

  it('keeps dedupe across a restart through persisted counters', () => {
    const runtime = createSequencer({ doc: createDocument(), seq: 10, counters: [['c', 5]] })
    expect(runtime.submit(op('c', 5, addA))).toEqual({ status: 'duplicate' })
    expect(runtime.submit(op('c', 6, addA))).toEqual({ status: 'applied', seq: 11 })
  })
})

describe('createMirror', () => {
  it('shows local ops at once and keeps them until the runtime confirms them', () => {
    const mirror = createMirror('me', createDocument(), 0)
    const mine = op('me', 1, addA)
    expect(mirror.propose(mine).error).toBeUndefined()
    expect(mirror.doc.panels.a).toBeDefined()
    expect(mirror.confirmed.panels.a).toBeUndefined()
    expect(mirror.pending).toEqual([mine])

    const outcome = mirror.applied(1, mine)
    expect(outcome).toMatchObject({ mine: true })
    expect(mirror.pending).toEqual([])
    expect(mirror.confirmed).toEqual(mirror.doc)
  })

  it('does not queue an op that fails locally', () => {
    const mirror = createMirror('me', createDocument(), 0)
    expect(mirror.propose(op('me', 1, rename('x'))).error?.code).toBe('gone')
    expect(mirror.pending).toEqual([])
  })

  it('rebuilds from confirmed state and re-applies unconfirmed ops on top', () => {
    const mirror = createMirror('me', createDocument(), 0)
    mirror.applied(1, op('other', 1, addA))
    mirror.propose(op('me', 1, rename('mine')))
    const result = mirror.applied(2, op('other', 2, rename('theirs')))
    expect(result).toMatchObject({ mine: false })
    // Ours is still unconfirmed, so it shows on top of theirs.
    expect(mirror.doc.panels.a.title).toBe('mine')
    expect(mirror.confirmed.panels.a.title).toBe('theirs')
    mirror.applied(3, op('me', 1, rename('mine')))
    expect(mirror.doc.panels.a.title).toBe('mine')
  })

  it('drops a refused op and reports stale or missing seqs', () => {
    const mirror = createMirror('me', createDocument(), 0)
    const mine = op('me', 1, addA)
    mirror.propose(mine)
    mirror.refused(mine.opId)
    expect(mirror.pending).toEqual([])
    expect(mirror.doc.panels.a).toBeUndefined()
    expect(mirror.applied(2, op('x', 1, addA))).toBe('gap')
    mirror.applied(1, op('x', 1, addA))
    expect(mirror.applied(1, op('x', 1, addA))).toBe('stale')
  })

  it('takes a full document and keeps unconfirmed ops on top', () => {
    const runtime = createSequencer({ doc: createDocument() })
    runtime.submit(op('other', 1, addA))
    const mirror = createMirror('me', createDocument(), 0)
    mirror.propose(op('me', 1, { kind: 'addPanel', record: { id: 'b', type: 'terminal', title: 'b', fields: {} }, at: { to: 'stack', dock: { windowId: 'main', layoutId: 'main' }, stackId: 's2' } }))
    mirror.reset(runtime.doc, runtime.seq)
    expect(mirror.seq).toBe(1)
    expect(mirror.confirmed).toBe(runtime.doc)
    // b's stack no longer exists in the new main dock: it stays queued, not shown.
    expect(mirror.pending).toHaveLength(1)
    expect(mirror.doc).toBe(runtime.doc)
  })
})
