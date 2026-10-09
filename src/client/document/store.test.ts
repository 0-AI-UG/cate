import { describe, expect, it, vi } from 'vitest'
import { ConnectionClosedError, RpcError, createMemoryPortPair, type FramePort } from '@kernel/rpc/contract'
import { RpcClient, createCapabilityProxy } from '@kernel/rpc/client'
import { RpcServer, type CapabilityImpl } from '@kernel/rpc/runtime'
import {
  MAIN_WINDOW,
  createDocument,
  createSequencer,
  documentCapability,
  type ApplyResult,
  type DocChange,
  type DocumentEvent,
  type DocOp,
  type PanelRecord,
} from '@workspace/document/contract'
import { createRng, randomChange } from '../../test/documentFuzz'
import { createDocumentStore, type DocumentLink, type DocumentStore, type RefusedOp } from './store'
import { createLifecycleBus } from '@kernel/lifecycle/contract'

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

const record = (id: string): PanelRecord => ({ id, type: 'terminal', title: id, fields: {} })
const add = (id: string): DocChange => ({ kind: 'addPanel', record: record(id), at: { to: 'stack', dock: { windowId: MAIN_WINDOW }, stackId: 's1' } })
const title = (id: string, value: string): DocChange => ({ kind: 'updatePanel', id, patch: { title: value } })

/** A document runtime over a real RpcServer, ordering ops with createSequencer. */
function fakeRuntime(keep = 10_000) {
  const sequencer = createSequencer({ doc: createDocument(), keep })
  const listeners = new Set<(event: DocumentEvent) => void>()
  const server = new RpcServer({ lifecycle: createLifecycleBus(), version: 'test' })
  const ports = new Map<string, FramePort>()
  let loseNextApply: string | null = null
  const impl: CapabilityImpl<typeof documentCapability> = {
    apply: ({ op }) => {
      if (loseNextApply === op.opId.clientId) {
        // The op lands, but the connection drops before anything gets back.
        loseNextApply = null
        ports.get(op.opId.clientId)?.close('lost')
      }
      const result = sequencer.submit(op)
      if (result.status === 'failed') throw new RpcError(result.error.code, result.error.message)
      if (result.status === 'applied') for (const l of [...listeners]) l({ kind: 'op', seq: result.seq, op })
      return result
    },
    subscribe: ({ sinceSeq } = {}, sink) => {
      const missed = typeof sinceSeq === 'number' ? sequencer.since(sinceSeq) : null
      if (missed) for (const { seq, op } of missed) sink.emit({ kind: 'op', seq, op })
      else sink.emit({ kind: 'doc', seq: sequencer.seq, epoch: sequencer.epoch, doc: sequencer.doc })
      const listener = (event: DocumentEvent) => sink.emit(event)
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  server.register(documentCapability, impl)

  const client = (clientId: string) => {
    let counter = 0
    const nextCounter = () => ++counter
    const rpc = new RpcClient({ version: 'test', identity: { client: { clientId, device: { name: clientId, publicKey: 'FP' }, features: [] } }, nextOpCounter: nextCounter })
    const connect = () => {
      const [mine, theirs] = createMemoryPortPair()
      ports.set(clientId, mine)
      server.serve(theirs)
      return rpc.attach(mine)
    }
    const link: DocumentLink = {
      clientId,
      nextCounter,
      remote: createCapabilityProxy(rpc, documentCapability),
      onReady: (listener) => rpc.onReady(listener),
    }
    const store = createDocumentStore(link)
    const refused: RefusedOp[] = []
    store.onRefused((r) => refused.push(r))
    return { rpc, store, refused, connect, drop: () => ports.get(clientId)?.close('dropped') }
  }

  return {
    sequencer,
    client,
    loseNextApply: (clientId: string) => { loseNextApply = clientId },
  }
}

async function connected(rt: ReturnType<typeof fakeRuntime>, id: string) {
  const c = rt.client(id)
  await c.connect()
  await c.store.ready
  return c
}

describe('document store', () => {
  it('applies a local op at once and clears it when the runtime confirms', async () => {
    const rt = fakeRuntime()
    const a = await connected(rt, 'a')
    const result = a.store.propose(add('p1'))
    expect(result).toEqual({ ok: true, opId: { clientId: 'a', counter: 1 } })
    expect(a.store.getSnapshot().panels.p1).toBeDefined()
    expect(a.store.pending).toHaveLength(1)
    await vi.waitFor(() => expect(a.store.pending).toHaveLength(0))
    expect(a.store.seq).toBe(1)
    expect(a.store.getSnapshot()).toEqual(rt.sequencer.doc)
  })

  it('drops an op the runtime refuses and says why', async () => {
    const rt = fakeRuntime()
    const a = await connected(rt, 'a')
    const b = await connected(rt, 'b')
    a.store.propose(add('p1'))
    await vi.waitFor(() => expect(b.store.getSnapshot().panels.p1).toBeDefined())

    // b renames p1 while a removes it; the runtime sees the removal first.
    a.store.propose({ kind: 'removePanels', ids: ['p1'] })
    b.store.propose(title('p1', 'renamed'))
    expect(b.store.getSnapshot().panels.p1.title).toBe('renamed')
    await vi.waitFor(() => expect(b.refused).toHaveLength(1))
    expect(b.refused[0]).toMatchObject({ code: 'gone', local: false, op: { kind: 'updatePanel', id: 'p1' } })
    expect(b.store.pending).toEqual([])
    expect(b.store.getSnapshot()).toEqual(rt.sequencer.doc)
    expect(b.store.getSnapshot().panels.p1).toBeUndefined()
  })

  it('refuses locally what fails on the view, without sending it', async () => {
    const rt = fakeRuntime()
    const a = await connected(rt, 'a')
    const result = a.store.propose(title('missing', 'x'))
    expect(result.ok).toBe(false)
    expect(a.refused[0]).toMatchObject({ code: 'gone', local: true })
    await tick()
    expect(rt.sequencer.seq).toBe(0)
  })

  it('resumes after a reconnect: missed ops arrive and nothing is applied twice', async () => {
    const rt = fakeRuntime()
    const a = await connected(rt, 'a')
    const b = await connected(rt, 'b')

    rt.loseNextApply('a')
    a.store.propose(add('p1'))
    await tick()
    await tick()
    expect(rt.sequencer.seq).toBe(1)
    expect(a.store.pending).toHaveLength(1)

    // While a is away: b adds a panel, and a proposes another.
    b.store.propose(add('p2'))
    a.store.propose(add('p3'))
    await vi.waitFor(() => expect(rt.sequencer.seq).toBe(2))
    expect(a.store.getSnapshot().panels.p3).toBeDefined()

    await a.connect()
    await vi.waitFor(() => expect(a.store.pending).toHaveLength(0))
    await vi.waitFor(() => expect(b.store.pending).toHaveLength(0))
    expect(rt.sequencer.seq).toBe(3)
    expect(a.store.getSnapshot()).toEqual(rt.sequencer.doc)
    expect(b.store.getSnapshot()).toEqual(rt.sequencer.doc)
    expect(Object.keys(rt.sequencer.doc.panels).sort()).toEqual(['p1', 'p2', 'p3'])
  })

  it('takes the full document when the ops it missed are no longer kept', async () => {
    const rt = fakeRuntime(2)
    const a = await connected(rt, 'a')
    const b = await connected(rt, 'b')
    a.drop()
    for (let i = 0; i < 6; i++) b.store.propose(add(`p${i}`))
    await vi.waitFor(() => expect(rt.sequencer.seq).toBe(6))
    await a.connect()
    await vi.waitFor(() => expect(a.store.seq).toBe(6))
    expect(a.store.getSnapshot()).toEqual(rt.sequencer.doc)
  })

  it('resends an op whose call failed once the connection is back', async () => {
    let fail = true
    const sent: DocOp[] = []
    let ready: ((info: { reconnect: boolean }) => void) | null = null
    let emit: ((event: DocumentEvent) => void) | null = null
    let counter = 0
    const store: DocumentStore = createDocumentStore({
      clientId: 'a',
      nextCounter: () => ++counter,
      onReady: (listener) => { ready = listener; return () => {} },
      remote: {
        apply: async ({ op }): Promise<ApplyResult> => {
          sent.push(op)
          if (fail) throw new ConnectionClosedError()
          emit!({ kind: 'op', seq: 1, op })
          return { status: 'applied', seq: 1 }
        },
        subscribe: () => {
          const sub = {
            onEvent: (listener: (event: DocumentEvent) => void) => { emit = listener; return () => {} },
            onBytes: () => () => {},
            write: () => {},
            ack: () => {},
            done: new Promise<void>(() => {}),
            cancel: () => {},
            [Symbol.asyncIterator]: () => { throw new Error('unused') },
          }
          queueMicrotask(() => emit!({ kind: 'doc', seq: 0, epoch: 'e', doc: createDocument() }))
          return sub
        },
      },
    })
    await store.ready
    store.propose(add('p1'))
    await tick()
    expect(sent).toHaveLength(1)
    expect(store.pending).toHaveLength(1)
    fail = false
    ready!({ reconnect: true })
    await tick()
    expect(sent).toHaveLength(2)
    expect(sent[1].opId).toEqual(sent[0].opId)
    expect(store.pending).toHaveLength(0)
  })

  it('converges two mirrors sending random ops at the same time', async () => {
    const rt = fakeRuntime()
    const a = await connected(rt, 'a')
    const b = await connected(rt, 'b')
    const rng = createRng(7)
    let ids = 0
    const newId = () => `id-${++ids}`
    for (let i = 0; i < 200; i++) {
      const c = rng.chance(0.5) ? a : b
      c.store.propose(randomChange(c.store.getSnapshot(), rng, newId))
      if (rng.chance(0.3)) await tick()
      if (i === 100) b.drop()
      if (i === 150) await b.connect()
    }
    await vi.waitFor(() => {
      expect(a.store.pending).toEqual([])
      expect(b.store.pending).toEqual([])
    })
    expect(a.store.getSnapshot()).toEqual(rt.sequencer.doc)
    expect(b.store.getSnapshot()).toEqual(rt.sequencer.doc)
  })
})

describe('undo', () => {
  it('undoes and redoes its own confirmed ops', async () => {
    const rt = fakeRuntime()
    const a = await connected(rt, 'a')
    a.store.propose(add('p1'))
    await vi.waitFor(() => expect(a.store.getUndoState().canUndo).toBe(true))
    a.store.propose(title('p1', 'one'))
    await vi.waitFor(() => expect(a.store.pending).toHaveLength(0))

    expect(a.store.undo()).toBe(true)
    expect(a.store.getSnapshot().panels.p1.title).toBe('p1')
    await vi.waitFor(() => expect(a.store.getUndoState().canRedo).toBe(true))
    expect(rt.sequencer.doc.panels.p1.title).toBe('p1')

    expect(a.store.redo()).toBe(true)
    await vi.waitFor(() => expect(rt.sequencer.doc.panels.p1.title).toBe('one'))

    await vi.waitFor(() => expect(a.store.pending).toHaveLength(0))
    expect(a.store.undo()).toBe(true)
    await vi.waitFor(() => expect(a.store.pending).toHaveLength(0))
    expect(a.store.undo()).toBe(true)
    await vi.waitFor(() => expect(rt.sequencer.doc.panels.p1).toBeUndefined())
    expect(a.store.getUndoState().canUndo).toBe(false)
  })

  it('does not undo other clients\' ops', async () => {
    const rt = fakeRuntime()
    const a = await connected(rt, 'a')
    const b = await connected(rt, 'b')
    b.store.propose(add('p1'))
    await vi.waitFor(() => expect(a.store.getSnapshot().panels.p1).toBeDefined())
    expect(a.store.undo()).toBe(false)
  })

  it('skips the parts whose target is gone', async () => {
    const rt = fakeRuntime()
    const a = await connected(rt, 'a')
    const b = await connected(rt, 'b')
    a.store.propose({ kind: 'batch', changes: [add('p1'), add('p2')] }, { undoable: false })
    await vi.waitFor(() => expect(b.store.getSnapshot().panels.p2).toBeDefined())
    a.store.propose({ kind: 'batch', changes: [title('p1', 'x'), title('p2', 'y')] })
    await vi.waitFor(() => expect(a.store.getUndoState().canUndo).toBe(true))
    b.store.propose({ kind: 'removePanels', ids: ['p1'] })
    await vi.waitFor(() => expect(a.store.getSnapshot().panels.p1).toBeUndefined())

    expect(a.store.undo()).toBe(true)
    await vi.waitFor(() => expect(rt.sequencer.doc.panels.p2.title).toBe('p2'))
    expect(a.refused).toEqual([])
    expect(a.store.getSnapshot()).toEqual(rt.sequencer.doc)
  })

  it('does nothing when everything an entry names is gone', async () => {
    const rt = fakeRuntime()
    const a = await connected(rt, 'a')
    const b = await connected(rt, 'b')
    a.store.propose(add('p1'), { undoable: false })
    await vi.waitFor(() => expect(b.store.getSnapshot().panels.p1).toBeDefined())
    a.store.propose(title('p1', 'x'))
    await vi.waitFor(() => expect(a.store.getUndoState().canUndo).toBe(true))
    b.store.propose({ kind: 'removePanels', ids: ['p1'] })
    await vi.waitFor(() => expect(a.store.getSnapshot().panels.p1).toBeUndefined())
    const seq = rt.sequencer.seq
    expect(a.store.undo()).toBe(false)
    await tick()
    expect(rt.sequencer.seq).toBe(seq)
    expect(a.store.getUndoState().canUndo).toBe(false)
  })
})
