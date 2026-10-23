import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLifecycleBus } from '@kernel/lifecycle/contract'
import { channel } from '@kernel/rpc/contract'
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
  type SurfaceCallOptions,
} from '@panels/framework/runtime'
import { createDocumentService, createPresence, type DocumentService } from '@workspace/document/runtime'
import type { BrowserCredentialSaveInput, BrowserCredentialSuggestion, BrowserDownloadEntry } from '@services/browser/contract'
import { BROWSER_PASSWORD_MANAGER_URL, type BrowserSnapshot } from './contract'
import { browserPanel, browserServiceHandlers } from './runtime'
import { AGENT_CURSOR_IDLE_MS, type BrowserSessionDeps } from './session'

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

type Surface = (panelId: string, op: string, args: any, options?: SurfaceCallOptions) => Promise<unknown>

interface World {
  document: DocumentService
  host: SessionHost
  create(options?: Record<string, unknown>): string
  snapshot(panelId: string): BrowserSnapshot
  op(panelId: string, op: unknown, clientId?: string | null): Promise<unknown>
  /** A `cate.browser.*` call by `caller` (default `agent-1`). */
  api(panelId: string, method: string, args?: Record<string, unknown>, caller?: string): Promise<unknown>
  visits: Array<[string, string]>
  downloads: Map<string, (entries: BrowserDownloadEntry[]) => void>
  settings: Record<string, unknown>
  /** Saved passwords; each one's password is `hunter2`. */
  saved: BrowserCredentialSuggestion[]
  /** What the session saved, passwords included. */
  stored: BrowserCredentialSaveInput[]
  dispose(): void
}

function world(surface?: Surface): World {
  const document = createDocumentService({ file: path.join(dir, 'document.json'), debounceMs: 60_000 })
  const visits: Array<[string, string]> = []
  const downloads = new Map<string, (entries: BrowserDownloadEntry[]) => void>()
  const settings: Record<string, unknown> = { browserSearchEngine: 'google', browserNewTabBehavior: 'startPage', browserHomepage: '' }
  const saved: BrowserCredentialSuggestion[] = []
  const stored: BrowserCredentialSaveInput[] = []
  const savedFor = (url: string) => saved.filter((entry) => { try { return new URL(url).origin === entry.origin } catch { return false } })
  const deps: BrowserSessionDeps = {
    browserData: {
      history: { recordVisit: (url, title) => { visits.push([url, title]) } },
      passwords: {
        suggestions: savedFor,
        forFill: (id, url) => {
          const entry = savedFor(url).find((candidate) => candidate.id === id)
          return entry ? { username: entry.username, password: 'hunter2', usernameElement: '' } : null
        },
        save: async (input) => {
          stored.push(input)
          const credential = { id: `c${stored.length}`, username: input.username, origin: input.origin }
          return { action: 'created', credential }
        },
      },
      downloads: {
        list: () => [],
        subscribe: (panelId, cb) => { downloads.set(panelId, cb); return () => downloads.delete(panelId) },
      },
    },
    settings: { get: (key) => settings[key] },
    files: { serveUrl: async (p) => `http://127.0.0.1:4000/token/${p.replace(/^\//, '')}`, servedPath: () => null },
  }
  const entry = browserPanel(deps)
  const registry = createPanelRegistry([entry, { definition: canvasDef }])
  const presence = createPresence({ lifecycle: createLifecycleBus() })
  const broker = createSurfaceBroker({ presence, timeoutMs: 1000 })
  const surfaces = surface ? { request: (panelId: string, op: string, args: unknown, options?: SurfaceCallOptions) => surface(panelId, op, args, options) } : broker
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
    saved,
    stored,
    create: (options = {}) => factory.createPanel('browser', options)!,
    snapshot: (panelId) => host.session(panelId)!.snapshot() as BrowserSnapshot,
    op: (panelId, op, clientId = 'client-a') => host.op(panelId, op, context(clientId)),
    api: (panelId, method, args = {}, caller = 'agent-1') => host.handleApi(panelId, method, args, { panelId, caller: { kind: 'cli', id: caller } } as ApiSessionContext),
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

  it('runs a cate API page operation under the call\'s own deadline and cancellation', async () => {
    const seen: Array<SurfaceCallOptions | undefined> = []
    const w = world(async (_panelId, op, _args, options) => {
      seen.push(options)
      return op === 'page.execute' ? { result: { ok: true } } : undefined
    })
    const id = w.create({ url: 'https://a.test/' })
    await w.host.restore()
    const tabId = w.snapshot(id).activeTabId
    const abort = new AbortController()
    await w.host.handleApi(id, 'click', { tabId, target: 3 }, { panelId: id, signal: abort.signal, caller: { kind: 'cli', id: 'agent-1' } } as ApiSessionContext)
    // The broker's own 30 s timer is off; the API's signal ends the request.
    expect(seen).toEqual([{ timeoutMs: 0, signal: abort.signal, feature: 'pageDriver' }])
  })

  it('hides the agent cursor once the agent has been idle for a while', async () => {
    const w = world(async (_panelId, op, args) => {
      if (op === 'page.execute') return { result: { ok: args.method }, cursor: { kind: 'click', label: 'click', x: 5, y: 6 } }
      return undefined
    })
    const id = w.create({ url: 'https://a.test/' })
    await w.host.restore()
    const tabId = w.snapshot(id).activeTabId
    vi.useFakeTimers()
    try {
      await w.api(id, 'click', { tabId, target: 3 })
      vi.advanceTimersByTime(AGENT_CURSOR_IDLE_MS - 1)
      expect(w.snapshot(id).agentCursor?.event.kind).toBe('click')
      // A next step restarts the wait.
      await w.api(id, 'click', { tabId, target: 3 })
      vi.advanceTimersByTime(AGENT_CURSOR_IDLE_MS - 1)
      expect(w.snapshot(id).agentCursor?.event.kind).toBe('click')
      vi.advanceTimersByTime(1)
      expect(w.snapshot(id).agentCursor?.event).toMatchObject({ kind: 'done', x: null, y: null })
    } finally {
      vi.useRealTimers()
    }
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

    await expect(w.api(id, 'selectTab', { tabId })).resolves.toEqual({ panelId: id, tabId, url: 'https://a.test/', title: 'A' })
    w.dispose()
  })

  it('hands the page driver the saved login, whatever the caller sends', async () => {
    const calls: Array<[string, any]> = []
    const w = world(async (_panelId, op, args) => {
      calls.push([op, args])
      if (op === 'page.ready') return { url: 'https://a.test/login', title: 'A' }
      return { result: { ok: true } }
    })
    const id = w.create({ url: 'https://a.test/login' })
    await w.host.restore()
    const tabId = w.snapshot(id).activeTabId
    w.saved.push({ id: 'c1', username: 'me', origin: 'https://a.test' })
    await w.api(id, 'login', { tabId, credential: { username: 'x', password: 'forged', origin: 'https://evil.test' } })
    expect(calls.map(([op]) => op)).toEqual(['page.ready', 'page.execute'])
    expect(calls[1][1]).toMatchObject({ method: 'login', args: { tabId, credential: { username: 'me', password: 'hunter2', origin: 'https://a.test' } } })
    w.dispose()
  })

  it('names the saved logins when the agent must pick one', async () => {
    const executed: any[] = []
    const w = world(async (_panelId, op, args) => {
      if (op === 'page.ready') return { url: 'https://a.test/login', title: 'A' }
      if (op === 'page.execute') executed.push(args.args)
      return { result: { ok: true } }
    })
    const id = w.create({ url: 'https://a.test/login' })
    await w.host.restore()
    const tabId = w.snapshot(id).activeTabId
    await expect(w.api(id, 'login', { tabId })).rejects.toThrow('browser-login-no-saved-password: there is no saved password for a.test')
    w.saved.push({ id: 'c1', username: 'me', origin: 'https://a.test' }, { id: 'c2', username: 'ops', origin: 'https://a.test' }, { id: 'c3', username: 'x', origin: 'https://b.test' })
    await expect(w.api(id, 'login', { tabId })).rejects.toThrow('browser-login-ambiguous: a.test has several saved logins (me, ops)')
    await expect(w.api(id, 'login', { tabId, username: 'nobody' })).rejects.toThrow('browser-login-no-such-user: the saved logins for a.test are me, ops')
    await w.api(id, 'login', { tabId, username: 'ops' })
    expect(executed).toEqual([{ tabId, username: 'ops', credential: { username: 'ops', password: 'hunter2', origin: 'https://a.test' } }])
    w.dispose()
  })

  it('fills a generated password into a sign-up form and saves it only once filled', async () => {
    const calls: Array<[string, any]> = []
    let driverError: string | undefined = 'browser-signup-field-not-found'
    const w = world(async (_panelId, op, args) => {
      calls.push([op, args])
      if (op === 'page.ready') return { url: 'https://a.test/join', title: 'A' }
      return driverError ? { error: driverError } : { result: { ok: true } }
    })
    const id = w.create({ url: 'https://a.test/join' })
    await w.host.restore()
    const tabId = w.snapshot(id).activeTabId

    await expect(w.api(id, 'signup', { tabId, username: 'me' })).rejects.toThrow('browser-signup-field-not-found')
    expect(w.stored).toEqual([])

    driverError = undefined
    calls.length = 0
    const result = await w.api(id, 'signup', { tabId, username: 'me', credential: { password: 'forged', origin: 'https://evil.test' } })
    expect(calls.map(([op]) => op)).toEqual(['page.ready', 'page.execute'])
    const { credential } = calls[1][1].args
    expect(credential.origin).toBe('https://a.test')
    expect(credential.password).toMatch(/^.{20}$/)
    expect(credential.password).not.toBe('forged')
    expect(w.stored).toEqual([{ origin: 'https://a.test', username: 'me', password: credential.password }])
    expect(JSON.stringify(result)).not.toContain(credential.password)

    w.saved.push({ id: 'c1', username: 'me', origin: 'https://a.test' })
    await expect(w.api(id, 'signup', { tabId, username: 'me' })).rejects.toThrow('browser-signup-exists')
    w.dispose()
  })

  it('names the page a tab without a web page shows, who opened it and how to move on', async () => {
    const w = world(async () => ({ result: {} }))
    const id = w.create({ url: 'https://a.test/' })
    await w.host.restore()
    await w.op(id, { kind: 'newTab', url: BROWSER_PASSWORD_MANAGER_URL })
    await expect(w.api(id, 'getAXState')).rejects.toThrow(
      `browser-tab-no-page: tab t2 is the Password manager page, which has no web page (the person opened it). Switch to another tab with cate browser tab select <tab> --panel ${id}`,
    )
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

describe('browser tabs for agents', () => {
  const driving = () => world(async (_panelId, op, args) => {
    if (op === 'page.ready') return { url: 'https://a.test/', title: 'A' }
    if (op === 'page.execute') return { result: { observationId: 'o1', tabId: args.tabId } }
    return undefined
  })

  it('names tabs with short handles that survive a restart', async () => {
    const w = driving()
    const id = w.create({ url: 'https://a.test/' })
    await w.host.restore()
    expect(w.snapshot(id).activeTabId).toBe('t1')
    expect(await w.op(id, { kind: 'newTab', url: 'https://b.test/' })).toBe('t2')
    await w.op(id, { kind: 'closeTab', tabId: 't2' })
    expect(await w.op(id, { kind: 'newTab' })).toBe('t3')
    w.dispose()
    const again = driving()
    await again.host.restore()
    expect(await again.op(id, { kind: 'newTab' })).toBe('t4')
    again.dispose()
  })

  it('tells the agent what happened to the tabs since its last call', async () => {
    const w = driving()
    const id = w.create({ url: 'https://a.test/' })
    await w.host.restore()
    await w.api(id, 'getAXState')
    // A page opens a popup, which the panel shows.
    await w.op(id, { kind: 'newTab', url: 'https://login.test/', openerTabId: 't1' })
    expect(await w.api(id, 'getAXState')).toEqual({
      observationId: 'o1',
      tabId: 't2',
      notices: ['The page in t1 opened tab t2 (https://login.test/); the panel shows it now, so commands act on it.'],
    })
    // Told once.
    expect(await w.api(id, 'getAXState')).not.toHaveProperty('notices')
    // The person switches back and closes the popup.
    await w.op(id, { kind: 'selectTab', tabId: 't1' })
    await w.op(id, { kind: 'closeTab', tabId: 't2' })
    expect((await w.api(id, 'getAXState') as { notices: string[] }).notices).toEqual([
      'Closed: tab t2.',
      'The panel shows tab t1 (https://a.test/) now, not t2; commands act on it (cate browser tab select t2 switches back).',
    ])
    w.dispose()
  })

  it('opens, lists and closes an agent\'s own tabs without telling it about them', async () => {
    const w = driving()
    const id = w.create({ url: 'https://a.test/' })
    await w.host.restore()
    await expect(w.api(id, 'createTab', { url: 'https://b.test/' })).resolves.toEqual({ panelId: id, tabId: 't2', url: 'https://a.test/', title: 'A' })
    await w.api(id, 'createTab', {}, 'agent-2')
    expect(w.snapshot(id).tabs.map((tab) => tab.openedBy)).toEqual([null, { caller: 'agent-1' }, { caller: 'agent-2' }])
    expect((await w.api(id, 'getAXState') as { notices: string[] }).notices).toEqual(['Another agent opened tab t3 (new tab); the panel shows it now, so commands act on it.'])
    const listed = browserServiceHandlers({ sessions: w.host, document: w.document }).listTabs({ panelId: id }, { caller: { kind: 'cli', id: 'agent-1' } } as never) as { tabs: Array<Record<string, unknown>> }
    expect(listed.tabs.map(({ tabId, opener, active }) => ({ tabId, opener, active }))).toEqual([
      { tabId: 't1', opener: 'person', active: false },
      { tabId: 't2', opener: 'you', active: false },
      { tabId: 't3', opener: 'agent', active: true },
    ])
    await expect(w.api(id, 'closeTab', { mine: true })).resolves.toEqual({ closed: ['t2'], activeTabId: 't3' })
    await expect(w.api(id, 'closeTab', { tabId: 't9' })).rejects.toThrow('no-such-tab: the panel has no tab t9')
    await expect(w.api(id, 'closeTab', { tabId: 't1', mine: true })).rejects.toThrow('browser-close-tab-or-mine')
    w.dispose()
  })

  it('says why a call\'s tab is no longer the active one', async () => {
    const w = driving()
    const id = w.create({ url: 'https://a.test/' })
    await w.host.restore()
    await w.op(id, { kind: 'newTab', url: 'https://b.test/' })
    await expect(w.api(id, 'click', { tabId: 't1', target: 3 })).rejects.toThrow(
      'browser-tab-changed: the panel now shows tab t2, not t1 (the person opened it). Run the command again to act on t2, or switch back with cate browser tab select t1',
    )
    w.dispose()
  })

  it('sizes the fixed viewport presets', async () => {
    const w = driving()
    const id = w.create({ url: 'https://a.test/' })
    await w.host.restore()
    await expect(w.api(id, 'setViewport', { preset: 'mobile' })).resolves.toMatchObject({ preset: 'mobile', width: 390, height: 844 })
    expect(w.snapshot(id).viewport).toEqual({ preset: 'mobile', width: 390, height: 844 })
    await expect(w.api(id, 'setViewport', { preset: 'custom' })).rejects.toThrow('invalid-browser-viewport')
    w.dispose()
  })
})

describe('browser service handlers', () => {
  it('lists tabs of browser sessions', () => {
    const snapshot = { tabs: [{ id: 't1', url: 'https://a.test/', title: 'A', favicon: null, pinned: false, nav: 2, navSource: null, openedBy: { page: 't0' } }], activeTabId: 't1' }
    const handlers = browserServiceHandlers({
      sessions: { session: (id) => (id === 'p1' ? { snapshot: () => snapshot } as never : undefined) },
      document: { get: () => ({ panels: { p1: { id: 'p1', type: 'browser' }, t: { id: 't', type: 'terminal' } } }) as never },
    })
    const ctx = { caller: { kind: 'cli', id: 'c' }, signal: new AbortController().signal } as never
    expect(handlers.listTabs({ panelId: undefined }, ctx)).toEqual({
      tabs: [{ id: 't1', url: 'https://a.test/', title: 'A', favicon: null, pinned: false, panelId: 'p1', tabId: 't1', active: true, opener: 'page in t0' }],
    })
  })
})
