import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLifecycleBus } from '@kernel/lifecycle/contract'
import { RpcError, channel } from '@kernel/rpc/contract'
import type { ApiSessionContext } from '@kernel/api/contract'
import { definePanel, definitionProblems } from '@panels/framework/contract'
import browserDefinition from './definition'
import {
  createPanelFactory,
  createPanelRegistry,
  createSessionHost,
  createSurfaceBroker,
  type OpContext,
  type SessionHost,
} from '@panels/framework/runtime'
import { createDocumentService, createPresence, type DocumentService } from '@workspace/document/runtime'
import type { BrowserDownloadEntry } from '@services/browser/contract'
import type { BrowserSnapshot } from './contract'
import { BrowserCodeCells } from './parts/runtime/codeCells'
import { browserPanel, browserServiceHandlers } from './runtime'
import type { BrowserSessionDeps } from './session'

const canvasDef = definePanel({
  type: 'canvas',
  label: 'Canvas',
  icon: 'grid',
  defaultSize: { width: 800, height: 600 },
  minimumSize: { width: 200, height: 200 },
  canLiveOnCanvas: false,
  requires: [],
  defaultTitle: 'Canvas',
  channel: channel<Record<string, never>>(),
  create: (options: object, kit) => kit.add(kit.record('canvas', { id: kit.newId(), canvasId: kit.newId() }), options),
})

let dir: string
let ids = 0
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-browser-session-'))
  ids = 0
})
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

type Surface = (panelId: string, op: string, args: any) => Promise<unknown>

interface World {
  document: DocumentService
  host: SessionHost
  create(options?: Record<string, unknown>): string
  snapshot(panelId: string): BrowserSnapshot
  op(panelId: string, op: unknown, clientId?: string | null): Promise<unknown>
  api(panelId: string, method: string, args?: Record<string, unknown>): Promise<unknown>
  visits: Array<[string, string]>
  downloads: Map<string, (entries: BrowserDownloadEntry[]) => void>
  settings: Record<string, unknown>
  dispose(): void
}

function world(surface?: Surface): World {
  const document = createDocumentService({ file: path.join(dir, 'document.json'), debounceMs: 60_000 })
  const visits: Array<[string, string]> = []
  const downloads = new Map<string, (entries: BrowserDownloadEntry[]) => void>()
  const settings: Record<string, unknown> = { browserSearchEngine: 'google', browserNewTabBehavior: 'startPage', browserHomepage: '' }
  const deps: BrowserSessionDeps = {
    browserData: {
      history: { recordVisit: (url, title) => { visits.push([url, title]) } },
      downloads: {
        list: () => [],
        subscribe: (panelId, cb) => { downloads.set(panelId, cb); return () => downloads.delete(panelId) },
      },
    },
    settings: { get: (key) => settings[key] },
    files: { serveUrl: async (p) => `http://127.0.0.1:4000/token/${p.replace(/^\//, '')}`, servedPath: () => null },
    newId: () => `n${++ids}`,
  }
  const entry = browserPanel(deps)
  const registry = createPanelRegistry([entry, { definition: canvasDef }])
  const presence = createPresence({ lifecycle: createLifecycleBus() })
  const broker = createSurfaceBroker({ presence, timeoutMs: 1000 })
  const surfaces = surface ? { request: (panelId: string, op: string, args: unknown) => surface(panelId, op, args) } : broker
  const host = createSessionHost({
    document,
    registry,
    surfaces,
    sessionFile: (panelId) => path.join(dir, 'sessions', `${panelId}.json`),
    persistDebounceMs: 5,
  })
  const factory = createPanelFactory({ document, registry, newId: () => `id${++ids}` })
  const context = (clientId: string | null): OpContext => ({ clientId, connectionId: clientId ? 1 : null })
  return {
    document,
    host,
    visits,
    downloads,
    settings,
    create: (options = {}) => factory.createPanel('browser', options)!,
    snapshot: (panelId) => host.session(panelId)!.snapshot() as BrowserSnapshot,
    op: (panelId, op, clientId = 'client-a') => host.op(panelId, op, context(clientId)),
    api: (panelId, method, args = {}) => host.handleApi(panelId, method, args, { panelId } as ApiSessionContext),
    dispose() {
      host.dispose()
      broker.dispose()
      presence.dispose()
      document.dispose()
    },
  }
}

describe('browser session', () => {
  it('has a valid definition', () => {
    expect(definitionProblems(browserDefinition)).toEqual([])
  })


  it('opens on the record url and keeps the record title and url in step with the active tab', async () => {
    const w = world()
    const id = w.create({ url: 'https://example.com/' })
    await w.host.restore()
    const snapshot = w.snapshot(id)
    expect(snapshot.tabs).toEqual([expect.objectContaining({ url: 'https://example.com/', nav: 0, navSource: null })])
    expect(snapshot.isLoading).toBe(true)

    await w.op(id, { kind: 'navigate', input: 'cats and dogs' })
    const tab = w.snapshot(id).tabs[0]
    expect(tab).toMatchObject({ url: 'https://www.google.com/search?q=cats%20and%20dogs', nav: 1, navSource: null })
    expect(w.document.get().panels[id].fields.url).toBe(tab.url)

    await w.op(id, { kind: 'reportTitle', tabId: tab.id, title: 'Cats' })
    expect(w.document.get().panels[id].title).toBe('Cats')
    w.dispose()
  })

  it('loads a typed path or file:// URL from the workspace runtime file server, never the client disk', async () => {
    const w = world()
    const id = w.create({ url: 'https://example.com/' })
    await w.host.restore()
    await w.op(id, { kind: 'navigate', input: '/work/site/index.html' })
    expect(w.snapshot(id).tabs[0].url).toBe('http://127.0.0.1:4000/token/work/site/index.html')
    await w.op(id, { kind: 'navigate', input: 'file:///work/a%20b.html' })
    expect(w.snapshot(id).tabs[0].url).toBe('http://127.0.0.1:4000/token/work/a b.html')
    w.dispose()
  })

  it('serves a file URL a panel is created on or a new tab opens', async () => {
    const w = world()
    const id = w.create({ url: 'file:///work/site/index.html' })
    await w.host.restore()
    await w.host.started(id)
    expect(w.snapshot(id).tabs[0].url).toBe('http://127.0.0.1:4000/token/work/site/index.html')
    const tabId = await w.op(id, { kind: 'newTab', url: 'file:///work/b.html' }) as string
    expect(w.snapshot(id).tabs.find((tab) => tab.id === tabId)?.url).toBe('http://127.0.0.1:4000/token/work/b.html')
    w.dispose()
  })

  it('follows client reports: a new url moves nav and names its source, the same url does not', async () => {
    const w = world()
    const id = w.create({ url: 'https://a.test/' })
    await w.host.restore()
    const tabId = w.snapshot(id).activeTabId
    await w.op(id, { kind: 'reportNavigation', tabId, url: 'about:blank', canGoBack: false, canGoForward: false })
    expect(w.snapshot(id).tabs[0].nav).toBe(0)

    await w.op(id, { kind: 'reportNavigation', tabId, url: 'https://a.test/next', title: 'Next', canGoBack: true, canGoForward: false }, 'client-b')
    expect(w.snapshot(id)).toMatchObject({ canGoBack: true, isLoading: false })
    expect(w.snapshot(id).tabs[0]).toMatchObject({ url: 'https://a.test/next', title: 'Next', nav: 1, navSource: 'client-b' })
    expect(w.visits).toEqual([['https://a.test/next', 'Next']])

    await w.op(id, { kind: 'reportNavigation', tabId, url: 'https://a.test/next', canGoBack: true, canGoForward: false }, 'client-a')
    expect(w.snapshot(id).tabs[0]).toMatchObject({ nav: 1, navSource: 'client-b' })
    w.dispose()
  })

  it('manages tabs and persists them', async () => {
    const w = world()
    const id = w.create()
    await w.host.restore()
    const first = w.snapshot(id).activeTabId
    const second = await w.op(id, { kind: 'newTab', url: 'https://b.test/' }) as string
    expect(w.snapshot(id).activeTabId).toBe(second)
    await w.op(id, { kind: 'pin', tabId: first })
    expect(w.snapshot(id).tabs[0].pinned).toBe(true)
    await w.op(id, { kind: 'selectTab', tabId: first })
    await w.op(id, { kind: 'closeTab', tabId: first })
    expect(w.snapshot(id).tabs.map((tab) => tab.id)).toEqual([second])
    await w.op(id, { kind: 'closeTab', tabId: second })
    expect(w.snapshot(id).tabs).toEqual([expect.objectContaining({ url: 'cate://newtab' })])
    await w.op(id, { kind: 'setViewport', viewport: { preset: 'mobile', width: 390, height: 844 } })
    await expect(w.op(id, { kind: 'selectTab', tabId: 'nope' })).rejects.toMatchObject({ code: 'gone' })
    w.dispose()

    const again = world()
    await again.host.restore()
    expect(again.snapshot(id)).toMatchObject({ viewport: { preset: 'mobile', width: 390, height: 844 }, tabs: [expect.objectContaining({ url: 'cate://newtab' })] })
    again.dispose()
  })

  it('names the client behind each selection, and none for a caller\'s', async () => {
    const w = world()
    const id = w.create()
    await w.host.restore()
    const first = w.snapshot(id).activeTabId
    const second = await w.op(id, { kind: 'newTab', url: 'https://b.test/' }, 'client-b') as string
    expect(w.snapshot(id)).toMatchObject({ activeTabId: second, activeSource: 'client-b' })
    await w.op(id, { kind: 'selectTab', tabId: first }, 'client-a')
    expect(w.snapshot(id)).toMatchObject({ activeTabId: first, activeSource: 'client-a' })
    await expect(w.api(id, 'createTab', { url: 'https://c.test/' })).rejects.toMatchObject({ code: 'no-renderer' })
    expect(w.snapshot(id).activeSource).toBeNull()
    expect(w.snapshot(id).tabs.find((tab) => tab.id === w.snapshot(id).activeTabId)?.url).toBe('https://c.test/')
    w.dispose()
  })

  it('publishes the panel downloads newest first', async () => {
    const w = world()
    const id = w.create()
    await w.host.restore()
    const entry = (n: number): BrowserDownloadEntry => ({ id: `d${n}`, url: 'u', filename: 'f', filePath: 'p', state: 'completed', receivedBytes: 1, totalBytes: 1, at: n })
    w.downloads.get(id)!([entry(1), entry(2)])
    expect(w.snapshot(id).downloads.map((d) => d.id)).toEqual(['d2', 'd1'])
    w.dispose()
  })

  it('fails page operations with no-renderer when no client can drive the page', async () => {
    const w = world()
    const id = w.create({ url: 'https://a.test/' })
    await w.host.restore()
    const tabId = w.snapshot(id).activeTabId
    await expect(w.api(id, 'getAXState', { tabId })).rejects.toMatchObject({ code: 'no-renderer' })
    await expect(w.op(id, { kind: 'history', action: 'back' })).rejects.toMatchObject({ code: 'no-renderer' })
    w.dispose()
  })

  it('runs page methods on the driving client and shows the agent cursor', async () => {
    const calls: Array<[string, any]> = []
    const w = world(async (_panelId, op, args) => {
      calls.push([op, args])
      if (op === 'page.execute') return { result: { ok: args.method }, cursor: { kind: 'click', label: 'click', x: 5, y: 6 } }
      if (op === 'page.ready') return { url: 'https://a.test/', title: 'A' }
      if (op === 'page.history') return { ok: false }
      return undefined
    })
    const id = w.create({ url: 'https://a.test/' })
    await w.host.restore()
    const tabId = w.snapshot(id).activeTabId

    await expect(w.api(id, 'click', { tabId, target: 3 })).resolves.toEqual({ ok: 'click' })
    expect(calls[0]).toEqual(['page.execute', { tabId, method: 'click', args: { tabId, target: 3 } }])
    expect(w.snapshot(id).agentCursor).toMatchObject({ event: { kind: 'click', x: 5, y: 6 }, serial: 2 })
    await w.op(id, { kind: 'releaseAgentCursor' })
    expect(w.snapshot(id).agentCursor?.event.kind).toBe('done')

    await expect(w.api(id, 'click', { tabId: 'other', target: 3 })).rejects.toThrow('browser-tab-changed')
    await expect(w.api(id, 'back', { tabId })).rejects.toThrow('no-history')

    calls.length = 0
    await w.api(id, 'goto', { tabId, url: 'b.test' })
    expect(w.snapshot(id).tabs[0]).toMatchObject({ url: 'https://b.test', nav: 1, navSource: null })
    expect(calls.map(([op]) => op)).toEqual(['page.ready', 'page.execute'])
    expect(calls[0][1]).toEqual({ tabId, nav: 1 })
    expect(calls[1][1]).toMatchObject({ method: 'getAXState', args: { disableDiffing: true } })

    await expect(w.api(id, 'getTab', {})).resolves.toEqual({ panelId: id, tabId, url: 'https://a.test/', title: 'A' })
    w.dispose()
  })

  it('surfaces driver errors with their recovery hint', async () => {
    const w = world(async () => ({ error: 'element-not-found', recovery: 'Observe again' }))
    const id = w.create({ url: 'https://a.test/' })
    await w.host.restore()
    await expect(w.api(id, 'getAXState', { tabId: w.snapshot(id).activeTabId })).rejects.toThrow('element-not-found: Observe again')
    w.dispose()
  })
})

describe('browser service handlers', () => {
  it('runs a cell on the driving client and passes its calls back as the caller', async () => {
    const cells = new BrowserCodeCells()
    const requests: Array<[string, string, any]> = []
    let cellId = ''
    const invoke = vi.fn(async () => ({ ok: true }))
    const handlers = browserServiceHandlers({
      surfaces: {
        request: async (panelId, op, args: any) => {
          requests.push([panelId, op, args])
          cellId = args.cellId
          await expect(cells.call(cellId, 'click', { panelId: 'p1', tabId: 't', target: 1 })).resolves.toEqual({ ok: true })
          // The desktop code session tags every call; a service or session
          // method that takes no cell id must not see it.
          await cells.call(cellId, 'getTab', { panelId: 'p1', _codeCellId: cellId })
          return { content: [{ type: 'text', text: 'done' }] }
        },
      },
      sessions: { session: () => undefined },
      document: { get: () => ({ panels: {} }) as never },
      cells,
      newId: () => 'cell-1',
    })
    const ctx = { caller: { kind: 'cli', id: 'caller-1' }, defaultTarget: () => 'p1', invoke, signal: new AbortController().signal } as never
    await expect(handlers.run({ code: '1', panelId: undefined }, ctx)).resolves.toEqual({ content: [{ type: 'text', text: 'done' }] })
    expect(requests[0]).toEqual(['p1', 'code.run', { key: 'caller-1', cellId: 'cell-1', code: '1', deadlineMs: 30_000 }])
    expect(invoke).toHaveBeenNthCalledWith(1, 'cate.browser.click', { tabId: 't', target: 1, _codeCellId: 'cell-1', panelId: 'p1' })
    expect(invoke).toHaveBeenNthCalledWith(2, 'cate.browser.getTab', { panelId: 'p1' })
    await expect(cells.call(cellId, 'click', {})).rejects.toBeInstanceOf(RpcError)
  })

  it('reports no-renderer as a cell error and lists tabs of browser sessions', async () => {
    const snapshot = { tabs: [{ id: 't1', url: 'https://a.test/', title: 'A', favicon: null, pinned: false, nav: 2, navSource: null }], activeTabId: 't1' }
    const handlers = browserServiceHandlers({
      surfaces: { request: async () => { throw new RpcError('no-renderer') } },
      sessions: { session: (id) => (id === 'p1' ? { snapshot: () => snapshot } as never : undefined) },
      document: { get: () => ({ panels: { p1: { id: 'p1', type: 'browser' }, t: { id: 't', type: 'terminal' } } }) as never },
      cells: new BrowserCodeCells(),
    })
    const ctx = { caller: { kind: 'cli', id: 'c' }, defaultTarget: () => undefined, invoke: vi.fn(), signal: new AbortController().signal } as never
    await expect(handlers.run({ code: '1', panelId: undefined }, ctx)).resolves.toMatchObject({ isError: true })
    expect(handlers.listTabs({ panelId: undefined }, ctx)).toEqual({
      tabs: [{ id: 't1', url: 'https://a.test/', title: 'A', favicon: null, pinned: false, panelId: 'p1', tabId: 't1', active: true }],
    })
  })
})
