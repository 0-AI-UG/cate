import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLifecycleBus, type LifecycleBus } from '@kernel/lifecycle/contract'
import { createMemoryPortPair, isRpcError, type ClientFeature } from '@kernel/rpc/contract'
import { RpcServer } from '@kernel/rpc/runtime'
import { RpcClient, createCapabilityProxy } from '@kernel/rpc/client'
import {
  MAIN_WINDOW,
  createDocument,
  documentCapability,
  presenceCapability,
  type DocChange,
  type DocOp,
  type DocumentEvent,
  type PanelRecord,
  type PanelType,
} from '../contract'
import { createDocumentService, createPresence, documentCapabilityImpl, presenceCapabilityImpl } from './index'

let dir: string
let file: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-document-'))
  file = path.join(dir, 'document.json')
})
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

const record = (id: string, type: PanelType = 'terminal'): PanelRecord => ({ id, type, title: id, fields: {} })
const addPanel = (id: string, type: PanelType = 'terminal'): DocChange =>
  ({ kind: 'addPanel', record: record(id, type), at: { to: 'stack', dock: { windowId: MAIN_WINDOW }, stackId: 's1' } })
const op = (clientId: string, counter: number, change: DocChange): DocOp => ({ ...change, opId: { clientId, counter } })
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe('document service', () => {
  it('applies in order, numbers ops and tells listeners', () => {
    const doc = createDocumentService({ file })
    const seen: number[] = []
    doc.subscribe((e) => seen.push(e.seq))
    expect(doc.submit(op('c1', 1, addPanel('a')))).toEqual({ status: 'applied', seq: 1 })
    expect(doc.submit(op('c1', 1, addPanel('a')))).toEqual({ status: 'duplicate' })
    expect(doc.submit(op('c1', 2, { kind: 'removePanels', ids: ['zzz'] }))).toMatchObject({ status: 'failed', error: { code: 'gone' } })
    expect(doc.apply(addPanel('b'))).toBe(2)
    expect(seen).toEqual([1, 2])
    expect(Object.keys(doc.get().panels)).toEqual(['a', 'b'])
    doc.dispose()
  })

  it('a stop while a write is in flight keeps the newest document on disk', async () => {
    const doc = createDocumentService({ file, debounceMs: 60_000 })
    doc.apply(addPanel('a'))
    const writing = doc.flush()
    doc.apply(addPanel('b'))
    doc.dispose()
    await writing.catch(() => {})
    await new Promise((r) => setTimeout(r, 20))
    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as { document: { panels: Record<string, unknown> } }
    expect(Object.keys(saved.document.panels)).toEqual(['a', 'b'])
  })

  it('forgets the op counters of clients not seen for a week', async () => {
    const day = 24 * 60 * 60_000
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      seq: 0,
      counters: { gone: 5, recent: 3 },
      lastSeen: { gone: Date.now() - 8 * day, recent: Date.now() - day },
      document: createDocument(),
    }))
    const doc = createDocumentService({ file, debounceMs: 60_000 })
    doc.apply(addPanel('a'))
    await doc.flush()
    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as { counters: Record<string, number> }
    expect(Object.keys(saved.counters).sort()).toEqual(['recent', 'runtime'])
    doc.dispose()
  })

  it('throws coded errors for failed runtime ops', () => {
    const doc = createDocumentService({ file })
    try {
      doc.apply({ kind: 'updatePanel', id: 'nope', patch: { title: 'x' } })
      expect.unreachable()
    } catch (err) {
      expect(isRpcError(err, 'gone')).toBe(true)
    }
    doc.dispose()
  })

  it('persists debounced with seq and counters, and a resend after restart is not applied twice', async () => {
    const doc = createDocumentService({ file, debounceMs: 5 })
    doc.submit(op('c1', 1, addPanel('a')))
    doc.apply(addPanel('b'))
    await new Promise((r) => setTimeout(r, 30))
    await doc.flush()
    const saved = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(saved).toMatchObject({ version: 1, seq: 2, counters: { c1: 1, runtime: 1 } })
    doc.dispose()

    const again = createDocumentService({ file })
    expect(again.seq).toBe(2)
    expect(Object.keys(again.get().panels)).toEqual(['a', 'b'])
    expect(again.submit(op('c1', 1, addPanel('a')))).toEqual({ status: 'duplicate' })
    // A seq of the previous run gets the doc: the runtime may have lost ops
    // the client saw. Nothing older is kept either.
    expect(again.since(2, again.epoch)).toEqual([])
    expect(again.since(2, 'previous run')).toBeNull()
    expect(again.since(1, again.epoch)).toBeNull()
    // The runtime's own counter continues too.
    expect(again.apply(addPanel('c'))).toBe(3)
    expect(again.since(2, again.epoch)).toHaveLength(1)
    again.dispose()
  })

  it('writes pending changes on dispose', async () => {
    const doc = createDocumentService({ file, debounceMs: 60_000 })
    doc.apply(addPanel('a'))
    doc.dispose()
    expect(JSON.parse(await fs.readFile(file, 'utf8')).seq).toBe(1)
  })

  it('quarantines an invalid document.json and starts empty', async () => {
    await fs.writeFile(file, JSON.stringify({ version: 1, document: { panels: 3 } }))
    const doc = createDocumentService({ file })
    expect(doc.get().panels).toEqual({})
    const files = await fs.readdir(dir)
    expect(files.some((name) => name.startsWith('document.json.corrupt-'))).toBe(true)
    doc.dispose()
  })
})

function connectClient(server: RpcServer, clientId: string, features: ClientFeature[] = []) {
  const client = new RpcClient({
    version: '1.0.0',
    identity: { client: { clientId, device: { name: `${clientId}-mac`, publicKey: `fp-${clientId}` }, features } },
  })
  const [serverPort, clientPort] = createMemoryPortPair()
  server.serve(serverPort)
  const ready = client.attach(clientPort)
  return { client, ready, port: clientPort, doc: createCapabilityProxy(client, documentCapability), presence: createCapabilityProxy(client, presenceCapability) }
}

function setupServer(lifecycle: LifecycleBus = createLifecycleBus()) {
  const service = createDocumentService({ file, debounceMs: 60_000 })
  const presence = createPresence({ lifecycle })
  const server = new RpcServer({ version: '1.0.0', lifecycle })
  server.register(documentCapability, documentCapabilityImpl(service, presence))
  server.register(presenceCapability, presenceCapabilityImpl(presence))
  return { service, presence, server }
}

describe('document capability', () => {
  it('broadcasts every applied op to every client', async () => {
    const { service, server } = setupServer()
    const a = connectClient(server, 'ca')
    const b = connectClient(server, 'cb')
    await Promise.all([a.ready, b.ready])
    const eventsA: DocumentEvent[] = []
    const eventsB: DocumentEvent[] = []
    a.doc.subscribe({}).onEvent((e) => eventsA.push(e))
    b.doc.subscribe({}).onEvent((e) => eventsB.push(e))
    await tick()
    await expect(a.doc.apply({ op: op('ca', 1, addPanel('p1')) })).resolves.toEqual({ status: 'applied', seq: 1 })
    service.apply(addPanel('p2'))
    await tick()
    for (const events of [eventsA, eventsB]) {
      expect(events.map((e) => e.kind)).toEqual(['doc', 'op', 'op'])
      expect(events.slice(1).map((e) => (e as { seq: number }).seq)).toEqual([1, 2])
    }
    service.dispose()
  })

  it('refuses ops that name another client and fails bad ops with their code', async () => {
    const { service, server } = setupServer()
    const a = connectClient(server, 'ca')
    await a.ready
    await expect(a.doc.apply({ op: op('someone', 1, addPanel('p1')) })).rejects.toMatchObject({ code: 'rejected' })
    await expect(a.doc.apply({ op: op('ca', 1, { kind: 'removePanels', ids: ['x'] }) })).rejects.toMatchObject({ code: 'gone' })
    service.dispose()
  })

  it('serves reconnects with the missed ops or the full document', async () => {
    const { service, server } = setupServer()
    service.apply(addPanel('p1'))
    service.apply(addPanel('p2'))
    service.apply(addPanel('p3'))
    const a = connectClient(server, 'ca')
    await a.ready
    const missed: DocumentEvent[] = []
    a.doc.subscribe({ sinceSeq: 1, epoch: service.epoch }).onEvent((e) => missed.push(e))
    await tick()
    expect(missed).toMatchObject([{ kind: 'op', seq: 2 }, { kind: 'op', seq: 3 }])

    const full: DocumentEvent[] = []
    a.doc.subscribe({ sinceSeq: 99, epoch: service.epoch }).onEvent((e) => full.push(e))
    await tick()
    expect(full).toMatchObject([{ kind: 'doc', seq: 3 }])
    expect(Object.keys((full[0] as { doc: { panels: object } }).doc.panels)).toEqual(['p1', 'p2', 'p3'])
    service.dispose()
  })
})

describe('presence', () => {
  it('tracks connected clients, reports and the last active client', async () => {
    let now = 1000
    const lifecycle = createLifecycleBus()
    const service = createDocumentService({ file, debounceMs: 60_000 })
    const presence = createPresence({ lifecycle, now: () => now })
    const server = new RpcServer({ version: '1.0.0', lifecycle })
    server.register(documentCapability, documentCapabilityImpl(service, presence))
    server.register(presenceCapability, presenceCapabilityImpl(presence))

    const a = connectClient(server, 'ca', ['pageDriver', 'webview'])
    const b = connectClient(server, 'cb')
    await Promise.all([a.ready, b.ready])
    expect(presence.clients().map((c) => c.clientId).sort()).toEqual(['ca', 'cb'])
    expect(presence.clients().find((c) => c.clientId === 'ca')).toMatchObject({
      device: { name: 'ca-mac', publicKey: 'fp-ca' },
      features: ['pageDriver', 'webview'],
    })

    now = 2000
    await a.presence.report({ viewing: ['p1', 'p2'], focused: 'p1' })
    expect(presence.activeClient()?.clientId).toBe('ca')
    expect(presence.activePanelId()).toBe('p1')

    now = 3000
    await b.presence.report({ viewing: ['p3'], focused: 'p3' })
    expect(presence.activeClient()).toMatchObject({ clientId: 'cb', lastActiveAt: 3000 })
    expect(presence.activePanelId()).toBe('p3')

    // Losing attention is reported but is not activity.
    await a.presence.report({ attentive: false })
    expect(presence.activeClient()?.clientId).toBe('cb')
    expect(presence.clients().find((c) => c.clientId === 'ca')).toMatchObject({ attentive: false, focused: 'p1' })

    // Sending a document op is activity too.
    await a.doc.apply({ op: op('ca', 1, addPanel('p9')) })
    expect(presence.activeClient()?.clientId).toBe('ca')

    const events: string[][] = []
    b.presence.subscribe().onEvent((e) => events.push(e.clients.map((c) => c.clientId)))
    await tick()
    a.port.close('bye')
    await tick()
    expect(presence.clients().map((c) => c.clientId)).toEqual(['cb'])
    expect(events.at(-1)).toEqual(['cb'])
    service.dispose()
    presence.dispose()
  })

  it('picks the client that last showed or used a panel, else the most recently active', () => {
    const lifecycle = createLifecycleBus()
    const presence = createPresence({ lifecycle })
    const device = { name: 'd', publicKey: 'f' }
    lifecycle.emitClientConnected({ connectionId: 1, clientId: 'a', device, features: ['pageDriver'] })
    lifecycle.emitClientConnected({ connectionId: 2, clientId: 'b', device, features: ['pageDriver'] })
    lifecycle.emitClientConnected({ connectionId: 3, clientId: 'c', device, features: [] })
    const driver = (c: { features: string[] }) => c.features.includes('pageDriver')
    presence.report(1, { viewing: ['p'] })
    presence.touch(2)
    expect(presence.pick(driver, 'p')?.clientId).toBe('a')
    expect(presence.pick(driver, 'other')?.clientId).toBe('b')
    presence.usedPanel(2, 'p')
    expect(presence.pick(driver, 'p')?.clientId).toBe('b')
    presence.touch(3)
    expect(presence.pick(driver)?.clientId).toBe('b')
    presence.dispose()
  })
})
