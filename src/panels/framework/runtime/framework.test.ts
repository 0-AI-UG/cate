import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineCateApi, defineCliArea, sessionApi, str } from '@kernel/api/contract'
import { ApiRouter, ApiTokenRegistry } from '@kernel/api/runtime'
import { createLifecycleBus } from '@kernel/lifecycle/contract'
import { RpcClient, createCapabilityProxy } from '@kernel/rpc/client'
import {
  RpcError,
  channel,
  createMemoryPortPair,
  isRpcError,
  type ChannelEvent,
  type ClientFeature,
} from '@kernel/rpc/contract'
import { RpcServer } from '@kernel/rpc/runtime'
import { canvasApi, panelApi } from '@workspace/document/contract/api'
import {
  MAIN_WINDOW,
  canvasOf,
  placementOf,
  type DocChange,
  type JsonObject,
  type PanelRecord,
  type PanelType,
} from '@workspace/document/contract'
import {
  createDocumentService,
  createPresence,
  registerDocumentApi,
  type DocumentService,
  type PresenceService,
} from '@workspace/document/runtime'
import { toWireError, type CapabilityProxy } from '@kernel/rpc/contract'
import type { SurfaceRequest } from '../contract'
import { SessionSubscriptions } from '@client/connections/session'
import { definePanel, definitionProblems, sessionCapability, surfaceCapability, type AnyPanelDefinition } from '../contract'
import {
  PanelSession,
  createPanelFactory,
  createPanelRegistry,
  createSessionHost,
  createSurfaceBroker,
  sessionCapabilityImpl,
  type OpContext,
  type OpHandlers,
  type SessionHost,
  type SessionKit,
} from './index'

// Areas as modules declare them (the kernel knows none).
const TEST_AREAS = {
  terminal: defineCliArea({
    label: 'Terminal',
    read: { key: 'cliTerminalReadEnabled', code: 'terminal-read-disabled', detail: 'read' },
    control: { key: 'cliTerminalInputEnabled', code: 'terminal-input-disabled', detail: 'input' },
  }),
  panel: defineCliArea({
    label: 'Panels',
    read: { key: 'cliPanelReadEnabled', code: 'panel-read-disabled', detail: 'read' },
    control: { key: 'cliPanelControlEnabled', code: 'panel-control-disabled', detail: 'control' },
  }),
  notify: defineCliArea({
    label: 'Notifications',
    control: { key: 'cliNotifyEnabled', code: 'notify-disabled', detail: 'notify' },
  }),
}


// ---- Fake panel types --------------------------------------------------------

const fakeTerminalApi = defineCateApi(
  'terminal',
  { read: { access: 'read', handler: 'session', args: { prefix: str } } },
  { area: TEST_AREAS.terminal },
)

type CounterSnapshot = { count: number; dirty: boolean }
type CounterOp = { kind: 'bump'; by: number } | { kind: 'setDirty'; dirty: boolean }

const log: string[] = []

class CounterSession extends PanelSession<CounterSnapshot, CounterOp> {
  constructor(kit: SessionKit, record: PanelRecord) {
    super(kit, record, { count: 0, dirty: false })
    log.push(`construct ${record.id}`)
  }
  override start(): void {
    const saved = this.persisted<{ count: number }>()
    if (saved) this.publish({ count: saved.count })
    log.push(`start ${this.panelId}`)
  }
  protected override readonly ops: OpHandlers<CounterOp> = {
    bump: ({ by }) => {
      this.publish({ count: this.state.count + by })
      this.persist({ count: this.state.count })
      return this.state.count
    },
    setDirty: ({ dirty }) => { this.publish({ dirty }) },
  }
  override handleApi = sessionApi(fakeTerminalApi, {
    read: ({ prefix }) => `${prefix}${this.state.count}`,
  })
  override closeBlocker(): RpcError | null {
    return this.state.dirty ? new RpcError('dirty', 'unsaved') : null
  }
  protected override release(reason: string): void {
    log.push(`dispose ${this.panelId} ${reason}`)
  }
}

class PageSession extends PanelSession<JsonObject, { kind: 'shot' }> {
  constructor(kit: SessionKit, record: PanelRecord) { super(kit, record, {}) }
  protected override readonly ops: OpHandlers<{ kind: 'shot' }> = {
    shot: () => this.withSurface('screenshot', { full: true }, { timeoutMs: 1000 }),
  }
}

const size = { width: 400, height: 300 }
const terminalDef = definePanel({
  type: 'terminal',
  label: 'Terminal',
  icon: 'terminal',
  defaultSize: size,
  minimumSize: size,
  canLiveOnCanvas: true,
  defaultTitle: 'Terminal',
  channel: channel<CounterSnapshot, Partial<CounterSnapshot>, CounterOp>(),
  api: fakeTerminalApi,
  commands: [{ id: 'bump', title: 'Bump', op: { kind: 'bump', by: 1 } }],
  create: (options: { near?: string; position?: { x: number; y: number } }, kit) =>
    kit.add(kit.record('terminal', { id: kit.newId(), title: kit.numberedTitle('terminal', 'Terminal') }), options),
})
const browserDef = definePanel({
  type: 'browser',
  label: 'Browser',
  icon: 'globe',
  defaultSize: size,
  minimumSize: size,
  canLiveOnCanvas: true,
  defaultTitle: 'Browser',
  surface: { retention: 'workspace', ops: { screenshot: 'pageDriver' } },
  channel: channel<JsonObject, Partial<JsonObject>, { kind: 'shot' }>(),
  fields: (options: { url?: string }) => ({ url: options.url ?? 'about:blank' }),
})
const canvasDef = definePanel({
  type: 'canvas',
  label: 'Canvas',
  icon: 'canvas',
  defaultSize: size,
  minimumSize: size,
  canLiveOnCanvas: false,
  defaultTitle: 'Canvas',
  channel: channel<JsonObject>(),
  create: (options: object, kit) => kit.add(kit.record('canvas', { id: kit.newId(), canvasId: kit.newId() }), options),
})
const surfaceDef = definePanel({
  type: 'surface',
  label: 'New panel',
  icon: 'plus',
  defaultSize: size,
  minimumSize: size,
  canLiveOnCanvas: true,
  defaultTitle: 'New panel',
  channel: channel<JsonObject>(),
})

const DEFINITIONS: AnyPanelDefinition[] = [terminalDef, browserDef, canvasDef, surfaceDef]

// ---- Setup -------------------------------------------------------------------

let dir: string
let ids = 0
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-panels-'))
  log.length = 0
  ids = 0
})
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true, maxRetries: 10 }) })

const sessionFile = (panelId: string) => path.join(dir, 'sessions', `${panelId}.json`)
const tick = () => new Promise<void>((r) => setTimeout(r, 0))
const record = (id: string, type: PanelType, extra: Partial<PanelRecord> = {}): PanelRecord => ({ id, type, title: id, fields: {}, ...extra })
const addTo = (id: string, type: PanelType = 'terminal', stackId = 's1'): DocChange =>
  ({ kind: 'addPanel', record: record(id, type), at: { to: 'stack', dock: { windowId: MAIN_WINDOW }, stackId } })

interface World {
  document: DocumentService
  presence: PresenceService
  host: SessionHost
  server: RpcServer
  lifecycle: ReturnType<typeof createLifecycleBus>
  broker: ReturnType<typeof createSurfaceBroker>
  factory: ReturnType<typeof createPanelFactory>
  dispose(): void
}

function world(opts: { document?: DocumentService } = {}): World {
  const lifecycle = createLifecycleBus()
  const document = opts.document ?? createDocumentService({ file: path.join(dir, 'document.json'), debounceMs: 60_000 })
  const presence = createPresence({ lifecycle })
  const registry = createPanelRegistry([
    { definition: terminalDef, session: CounterSession },
    { definition: browserDef, session: PageSession },
    { definition: canvasDef },
    { definition: surfaceDef },
  ])
  const broker = createSurfaceBroker({ presence, timeoutMs: 1000 })
  const host = createSessionHost({ document, registry, surfaces: broker, sessionFile, persistDebounceMs: 5 })
  const server = new RpcServer({ version: '1.0.0', lifecycle })
  server.register(sessionCapability, sessionCapabilityImpl({ host, presence }))
  server.register(surfaceCapability, broker.capability())
  const factory = createPanelFactory({ document, registry, newId: () => `id${++ids}` })
  return {
    document, presence, host, server, lifecycle, broker, factory,
    dispose() {
      host.dispose()
      broker.dispose()
      presence.dispose()
      document.dispose()
    },
  }
}

function connect(server: RpcServer, clientId: string, features: ClientFeature[] = []) {
  const client = new RpcClient({
    version: '1.0.0',
    identity: { client: { clientId, device: { name: clientId, publicKey: `fp-${clientId}` }, features } },
  })
  const [serverPort, clientPort] = createMemoryPortPair()
  server.serve(serverPort)
  const ready = client.attach(clientPort)
  return {
    ready,
    port: clientPort,
    session: createCapabilityProxy(client, sessionCapability),
    surface: createCapabilityProxy(client, surfaceCapability),
  }
}

// ---- Tests -------------------------------------------------------------------

describe('panel definitions', () => {
  it('every definition requires only known client features', () => {
    for (const definition of DEFINITIONS) expect(definitionProblems(definition), definition.type).toEqual([])
  })

  it('reports a command needing an unknown feature and refuses to register it', () => {
    const badCommand = { ...terminalDef, commands: [{ id: 'x', title: 'X', op: {}, requires: ['telepathy'] }] } as unknown as AnyPanelDefinition
    expect(definitionProblems(badCommand)).toEqual(['command x requires unknown feature "telepathy"'])
    expect(() => createPanelRegistry([{ definition: badCommand }])).toThrow(/telepathy/)
  })
})

describe('session host lifecycle', () => {
  it('starts a session on add, swaps on replace, disposes on remove and fails later ops with gone', async () => {
    const w = world()
    w.document.apply(addTo('t1'))
    await w.host.started('t1')
    expect(log).toEqual(['construct t1', 'start t1'])

    await expect(w.host.op('t1', { kind: 'bump', by: 2 }, { clientId: null, connectionId: null })).resolves.toBe(2)
    await expect(w.host.op('t1', { kind: 'nope' }, { clientId: null, connectionId: null })).rejects.toMatchObject({ code: 'rejected' })

    // A surface becomes a terminal under the same id.
    w.document.apply(addTo('s1p', 'surface'))
    const surfaceSession = w.host.session('s1p')
    w.document.apply({ kind: 'replacePanel', record: record('s1p', 'terminal') })
    expect(surfaceSession?.isDisposed).toBe(true)
    expect(w.host.session('s1p')).toBeInstanceOf(CounterSession)

    // A record change reaches the session without restarting it.
    w.document.apply({ kind: 'updatePanel', id: 't1', patch: { title: 'Renamed' } })
    expect(w.host.session('t1')?.record.title).toBe('Renamed')
    expect(log.filter((l) => l.startsWith('start t1'))).toHaveLength(1)

    const t1 = w.host.session('t1')!
    w.document.apply({ kind: 'removePanels', ids: ['t1'] })
    expect(t1.isDisposed).toBe(true)
    expect(log).toContain('dispose t1 removed')
    const err = await w.host.op('t1', { kind: 'bump', by: 1 }, { clientId: null, connectionId: null }).catch((e) => e)
    expect(isRpcError(err, 'gone')).toBe(true)
    w.dispose()
  })

  it('removes the panels of a closed window and a removed canvas', async () => {
    const w = world()
    const canvasId = w.factory.createPanel('canvas')!
    const canvas = w.document.get().panels[canvasId].canvasId!
    const onCanvas = w.factory.createPanel('terminal', {
      at: { to: 'canvas', canvasId: canvas, nodeId: 'n1', stackId: 'ns1', rect: { origin: { x: 0, y: 0 }, size } },
    })!
    // Near a panel on a canvas: a new node on the same canvas.
    const child = w.factory.createPanel('terminal', { near: onCanvas })!
    expect(canvasOf(w.document.get(), child)).toBe(canvas)
    expect(Object.keys(w.document.get().canvases[canvas].nodes)).toHaveLength(2)
    // A canvas panel near a panel on a canvas goes next to the canvas panel.
    const nested = w.factory.createPanel('canvas', { near: onCanvas })!
    expect(placementOf(w.document.get(), nested)?.dock).toEqual({ windowId: MAIN_WINDOW })
    const detached = w.factory.createPanel('terminal', {
      at: { to: 'window', windowId: 'w2', stackId: 'ws1' },
    })!
    await w.host.restore()

    w.document.apply({ kind: 'removePanels', ids: [canvasId] })
    for (const id of [canvasId, onCanvas, child]) expect(w.host.session(id)).toBeUndefined()
    expect(log).toContain(`dispose ${child} removed`)
    w.document.apply({ kind: 'closeWindow', windowId: 'w2' })
    expect(w.host.session(detached)).toBeUndefined()
    expect(w.host.session(nested)).toBeDefined()
    w.dispose()
  })

  it('persists session state, sets it aside with the panel and restores sessions at start', async () => {
    const docFile = path.join(dir, 'document.json')
    const first = world({ document: createDocumentService({ file: docFile, debounceMs: 60_000 }) })
    first.document.apply(addTo('t1'))
    first.document.apply(addTo('t2'))
    await first.host.op('t1', { kind: 'bump', by: 5 }, { clientId: null, connectionId: null })
    await first.host.op('t2', { kind: 'bump', by: 1 }, { clientId: null, connectionId: null })
    await new Promise((r) => setTimeout(r, 30))
    expect(JSON.parse(await fs.readFile(sessionFile('t1'), 'utf8'))).toEqual({ count: 5 })
    first.document.apply({ kind: 'removePanels', ids: ['t2'] })
    const removed = path.join(path.dirname(sessionFile('t2')), 'removed', path.basename(sessionFile('t2')))
    await vi.waitFor(() => fs.access(removed))
    await expect(fs.access(sessionFile('t2'))).rejects.toThrow()
    first.dispose()
    expect(log).toContain('dispose t1 shutdown')

    log.length = 0
    const second = world({ document: createDocumentService({ file: docFile, debounceMs: 60_000 }) })
    await second.host.restore()
    expect(log).toEqual(['construct t1', 'start t1'])
    expect(second.host.session('t1')?.snapshot()).toEqual({ count: 5, dirty: false })
    second.dispose()
  })

  it('brings back a removed panel\'s state when the panel comes back (undo)', async () => {
    const w = world()
    w.document.apply(addTo('t1'))
    await w.host.op('t1', { kind: 'bump', by: 3 }, { clientId: null, connectionId: null })
    // Removed while its write is still pending, and added back at once.
    w.document.apply({ kind: 'removePanels', ids: ['t1'] })
    w.document.apply(addTo('t1'))
    await w.host.started('t1')
    expect(w.host.session('t1')?.snapshot()).toEqual({ count: 3, dirty: false })
    await w.host.op('t1', { kind: 'bump', by: 1 }, { clientId: null, connectionId: null })
    await new Promise((r) => setTimeout(r, 30))
    expect(JSON.parse(await fs.readFile(sessionFile('t1'), 'utf8'))).toEqual({ count: 4 })
    w.dispose()
  })
})

describe('session channel over rpc', () => {
  it('sends the snapshot, then changes, and takes ops', async () => {
    const w = world()
    w.document.apply(addTo('t1'))
    await w.host.started('t1')
    const a = connect(w.server, 'ca')
    await a.ready
    const channelA = new SessionSubscriptions(a.session).acquire<CounterSnapshot>('t1')
    const revs: number[] = []
    channelA.subscribe(() => revs.push(channelA.getSnapshot()!.rev))
    await tick()
    expect(channelA.getSnapshot()).toEqual({ rev: 0, snapshot: { count: 0, dirty: false } })

    await expect(channelA.send({ kind: 'bump', by: 3 } satisfies CounterOp)).resolves.toBe(3)
    await tick()
    await tick()
    expect(channelA.getSnapshot()).toEqual({ rev: 1, snapshot: { count: 3, dirty: false } })
    expect(revs).toEqual([0, 1])

    // Removing the panel fails later ops with gone.
    w.document.apply({ kind: 'removePanels', ids: ['t1'] })
    await tick()
    await expect(a.session.op({ panelId: 't1', op: { kind: 'bump', by: 1 } })).rejects.toMatchObject({ code: 'gone' })
    channelA.release()
    w.dispose()
  })
})

/** A client answering page operations with `run`. */
function serveSurfaceRequests(surface: CapabilityProxy<typeof surfaceCapability>, run: (request: SurfaceRequest) => unknown): void {
  surface.requests().onEvent((request) => {
    void Promise.resolve().then(() => run(request)).then(
      (result) => surface.reply({ requestId: request.requestId, result }),
      (err) => surface.reply({ requestId: request.requestId, error: toWireError(err) }),
    )
  })
}

describe('driving client', () => {
  it('runs page ops on the client that last showed or used the panel, else the most recently active', async () => {
    const w = world()
    w.document.apply(addTo('b1', 'browser'))
    await w.host.started('b1')

    // No page driver connected yet.
    await expect(w.host.op('b1', { kind: 'shot' }, { clientId: null, connectionId: null })).rejects.toMatchObject({ code: 'no-renderer' })

    const plain = connect(w.server, 'plain')
    const d1 = connect(w.server, 'd1', ['pageDriver', 'webview'])
    const d2 = connect(w.server, 'd2', ['pageDriver', 'webview'])
    await Promise.all([plain.ready, d1.ready, d2.ready])
    const ran: string[] = []
    serveSurfaceRequests(d1.surface, (req) => { ran.push(`d1 ${req.op}`); return 'shot-from-d1' })
    serveSurfaceRequests(d2.surface, (req) => { ran.push(`d2 ${req.op}`); return 'shot-from-d2' })
    // A client without pageDriver may not drive.
    await expect(plain.surface.requests().done).rejects.toMatchObject({ code: 'rejected' })
    await tick()

    const conn = (clientId: string) => w.presence.clients().find((c) => c.clientId === clientId)!.connectionId
    // d2 acted last: it drives.
    w.presence.touch(conn('d2'))
    await expect(w.host.op('b1', { kind: 'shot' }, { clientId: null, connectionId: null })).resolves.toBe('shot-from-d2')

    // d1 shows the panel: it drives, even after d2 does something else.
    w.presence.report(conn('d1'), { viewing: ['b1'] })
    w.presence.touch(conn('d2'))
    await expect(w.host.op('b1', { kind: 'shot' }, { clientId: null, connectionId: null })).resolves.toBe('shot-from-d1')

    // d2 uses the panel through the session capability.
    await d2.session.op({ panelId: 'b1', op: { kind: 'shot' } })
    expect(ran).toEqual(['d2 screenshot', 'd1 screenshot', 'd2 screenshot'])

    // Driver errors come back with their code.
    const d3 = connect(w.server, 'd3', ['pageDriver'])
    await d3.ready
    serveSurfaceRequests(d3.surface, () => { throw new RpcError('rejected', 'no such element') })
    await tick()
    w.presence.usedPanel(conn('d3'), 'b1')
    await expect(w.host.op('b1', { kind: 'shot' }, { clientId: null, connectionId: null })).rejects.toMatchObject({ code: 'rejected', message: 'no such element' })

    // All drivers gone: no-renderer.
    d1.port.close('bye')
    d2.port.close('bye')
    d3.port.close('bye')
    await tick()
    await expect(w.host.op('b1', { kind: 'shot' }, { clientId: null, connectionId: null })).rejects.toMatchObject({ code: 'no-renderer' })
    w.dispose()
  })
})

describe('createPanel', () => {
  it('places next to the calling panel, on its canvas or in its stack, else the main window', () => {
    const w = world()
    const first = w.factory.createPanel('terminal')!
    expect(placementOf(w.document.get(), first)?.dock).toEqual({ windowId: MAIN_WINDOW })
    expect(w.document.get().panels[first].title).toBe('Terminal 1')
    const second = w.factory.createPanel('terminal', { near: first })!
    expect(w.document.get().panels[second].title).toBe('Terminal 2')
    expect(placementOf(w.document.get(), second)).toMatchObject({ stackId: placementOf(w.document.get(), first)!.stackId, index: 1 })

    const browser = w.factory.createPanel('browser', { url: 'https://example.com' })!
    expect(w.document.get().panels[browser].fields).toEqual({ url: 'https://example.com' })
    expect(w.factory.createPanel('nope')).toBeNull()
    w.dispose()
  })
})

describe('panel and canvas API handlers', () => {
  function apiWorld() {
    const w = world()
    const tokens = new ApiTokenRegistry(() => `tok-${Math.random()}`)
    const router = new ApiRouter({
      namespaces: [panelApi, canvasApi, fakeTerminalApi],
      document: {
        panel: (id) => { const r = w.document.get().panels[id]; return r ? { id: r.id, type: r.type } : undefined },
        panels: () => Object.values(w.document.get().panels).map((r) => ({ id: r.id, type: r.type })),
      },
      presence: w.presence,
      sessions: w.host,
      settings: { get: () => true },
      tokens,
    })
    registerDocumentApi(router, {
      document: w.document,
      presence: w.presence,
      checkRemoval: (removing, discard) => w.host.checkRemoval(removing, discard),
      createPanel: (type, request) => w.factory.createPanel(type, request),
    })
    return { ...w, router, tokens }
  }

  it('creates next to the caller, lists, renames, targets and closes', async () => {
    const w = apiWorld()
    w.document.apply(addTo('term-caller'))
    const cli = w.tokens.issue({ kind: 'cli', panelId: 'term-caller' })
    const created = await w.router.call(cli.caller, 'cate.canvas.createPanel', { type: 'browser', url: 'https://a.test' }) as { panelId: string }
    expect(placementOf(w.document.get(), created.panelId)).toMatchObject({ index: 1 })
    await expect(w.router.call(cli.caller, 'cate.canvas.createPanel', { type: 'bogus' })).rejects.toMatchObject({ code: 'rejected' })

    const rows = await w.router.call(cli.caller, 'cate.panel.list', {}) as Array<{ panelId: string; url?: string }>
    expect(rows.map((r) => r.panelId)).toEqual(['term-caller', created.panelId])
    expect(rows[1].url).toBe('https://a.test')

    await w.router.call(cli.caller, 'cate.panel.setTitle', { title: 'My shell' })
    expect(w.document.get().panels['term-caller'].title).toBe('My shell')

    await expect(w.router.call(cli.caller, 'cate.panel.target.current', {})).resolves.toEqual({ panelId: null })
    await w.router.call(cli.caller, 'cate.panel.target.set', { panelId: created.panelId.slice(0, 4) })
    await expect(w.router.call(cli.caller, 'cate.panel.target.current', {})).resolves.toEqual({ panelId: created.panelId })
    await w.router.call(cli.caller, 'cate.panel.target.clear', {})
    await expect(w.router.call(cli.caller, 'cate.panel.target.current', {})).resolves.toEqual({ panelId: null })

    // Session methods reach the session through the host.
    await expect(w.router.call(cli.caller, 'cate.terminal.read', { panelId: 'term-caller', prefix: 'n=' })).resolves.toBe('n=0')

    // Closing unsaved work needs discard.
    await w.host.op('term-caller', { kind: 'setDirty', dirty: true }, { clientId: null, connectionId: null })
    await expect(w.router.call(cli.caller, 'cate.panel.close', { panelId: 'term-caller' })).rejects.toMatchObject({ code: 'dirty' })
    expect(w.document.get().panels['term-caller']).toBeDefined()
    await expect(w.router.call(cli.caller, 'cate.panel.close', { panelId: 'term-caller', discard: true })).resolves.toEqual({ panelIds: ['term-caller'] })
    expect(w.document.get().panels['term-caller']).toBeUndefined()
    w.dispose()
  })
})

