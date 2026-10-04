import { describe, expect, it, vi } from 'vitest'
import { installClientIdentity } from '@client/connections'
import type { BrowserSnapshot, BrowserTab } from '@panels/browser/contract'
import type { ChatSnapshot } from '@panels/chat/contract'
import type { MobileBridge, MobileViewEvent } from '../contract'
import type { MobileClient } from './boot'
import { createMobileBrowsers } from './browser'
import { createMobileChats } from './chat'
import { createMobileViews } from './views'

const tick = () => new Promise((r) => setTimeout(r, 0))

installClientIdentity({ clientId: 'me', device: { name: 'phone', keyFingerprint: 'k' }, features: [] } as never)

function setup<S>(initial: S) {
  let snapshot: S = initial
  const listeners = new Set<() => void>()
  const sent: unknown[] = []
  const session = {
    released: false,
    getSnapshot: () => ({ rev: 1, snapshot }),
    subscribe: (l: () => void) => { listeners.add(l); return () => listeners.delete(l) },
    send: vi.fn(async (op: unknown) => { sent.push(op); return 'done' }),
    release() { this.released = true },
  }
  const connection = { subscribeSession: () => session }
  const client = {
    connections: { get: (id: string) => (id === 'ws1' ? connection : undefined), subscribe: () => () => {} },
  } as unknown as MobileClient
  const events: Array<{ viewId: string; event: MobileViewEvent }> = []
  const bridge = (async (method: string, params: { viewId: string; json: string }) => {
    if (method === 'view.event') events.push({ viewId: params.viewId, event: JSON.parse(params.json) })
    return null
  }) as MobileBridge
  const set = (next: S) => {
    snapshot = next
    for (const l of listeners) l()
  }
  return { client, bridge, session, sent, events, set, views: createMobileViews(client, bridge) }
}

describe('mobile panel views', () => {
  it('pushes the session snapshot and runs ops', async () => {
    const t = setup({ n: 1 })
    t.views.open({ viewId: 'v', workspaceId: 'ws1', panelId: 'p1' })
    await tick()
    t.set({ n: 2 })
    await tick()
    expect(t.events.map((e) => e.event)).toEqual([{ kind: 'snapshot', snapshot: { n: 1 } }, { kind: 'snapshot', snapshot: { n: 2 } }])
    expect(await t.views.op('v', { kind: 'save' })).toEqual({ ok: true, result: 'done' })
    t.session.send.mockRejectedValueOnce(new Error('nope'))
    expect(await t.views.op('v', { kind: 'save' })).toMatchObject({ ok: false, message: 'nope' })
    t.views.get('v')!.close()
    expect(t.session.released).toBe(true)
    expect(await t.views.op('v', {})).toMatchObject({ ok: false })
  })
})

const tab = (patch: Partial<BrowserTab> = {}): BrowserTab => ({
  id: 't1', url: 'http://localhost:3000/', title: '', favicon: null, pinned: false, nav: 1, navSource: null, ...patch,
})
const browserSnapshot = (tabs: BrowserTab[]): BrowserSnapshot => ({
  tabs, activeTabId: tabs[0].id, activeSource: null, viewport: { preset: 'compact' } as never,
  canGoBack: false, canGoForward: false, isLoading: false, loadError: null, crashed: false, downloads: [], agentCursor: null,
})

describe('mobile browser views', () => {
  it('loads URLs other clients navigated to, never its own', async () => {
    const t = setup(browserSnapshot([tab()]))
    const browsers = createMobileBrowsers(t.views)
    browsers.open({ viewId: 'v', workspaceId: 'ws1', panelId: 'p1' })
    await tick()
    t.set(browserSnapshot([tab({ nav: 2, url: 'http://localhost:3000/a', navSource: 'other' })]))
    t.set(browserSnapshot([tab({ nav: 3, url: 'http://localhost:3000/b', navSource: 'me' })]))
    t.set(browserSnapshot([tab({ nav: 4, url: 'cate://newtab', navSource: null })]))
    await tick()
    expect(t.events.flatMap((e) => (e.event.kind === 'load' ? [e.event.url] : []))).toEqual(['http://localhost:3000/a'])
  })

  it('reports its own navigations, and only the history of a followed load', async () => {
    const t = setup(browserSnapshot([tab()]))
    const browsers = createMobileBrowsers(t.views)
    browsers.open({ viewId: 'v', workspaceId: 'ws1', panelId: 'p1' })
    await tick()
    browsers.navigated({ viewId: 'v', tabId: 't1', url: 'http://localhost:3000/x', title: 'X', inPage: false, canGoBack: true, canGoForward: false })
    t.set(browserSnapshot([tab({ nav: 2, url: 'http://localhost:3000/y', navSource: 'other' })]))
    browsers.navigated({ viewId: 'v', tabId: 't1', url: 'http://localhost:3000/y?r', title: 'Y', inPage: false, canGoBack: true, canGoForward: false })
    browsers.loading({ viewId: 'v', tabId: 't1', loading: false, loadError: null })
    browsers.navigated({ viewId: 'v', tabId: 't1', url: 'http://localhost:3000/z', title: '', inPage: true, canGoBack: true, canGoForward: false })
    await tick()
    expect(t.sent).toEqual([
      { kind: 'reportNavigation', tabId: 't1', url: 'http://localhost:3000/x', title: 'X', canGoBack: true, canGoForward: false },
      { kind: 'reportLoad', tabId: 't1', canGoBack: true, canGoForward: false },
      { kind: 'reportLoad', tabId: 't1', loading: false },
      { kind: 'reportNavigation', tabId: 't1', url: 'http://localhost:3000/z', inPage: true, canGoBack: true, canGoForward: false },
    ])
  })
})

const harness = { origin: 'http://127.0.0.1:4000', port: 4000, instanceId: 'i', environmentId: 'env', session: { name: 's', value: 'v' } }
const chatSnapshot = (patch: Partial<ChatSnapshot> = {}): ChatSnapshot => ({
  checkout: '/repo', threadId: 'th1', phase: 'ready', error: null, harness, loadId: 1, connected: true, activity: null,
  agentName: null, canReceivePrompt: true, changes: null, ...patch,
})

describe('mobile chat views', () => {
  it('loads the bound thread with the harness cookie', async () => {
    const t = setup(chatSnapshot())
    const chats = createMobileChats(t.views, t.bridge)
    chats.open({ viewId: 'v', workspaceId: 'ws1', panelId: 'p1' })
    await tick()
    const page = chats.page({ viewId: 'v', dark: true })!
    expect(page).toMatchObject({ loadId: 1, url: 'http://127.0.0.1:4000/env/th1', cookie: { name: 's', value: 'v' } })
    expect(page.script).toContain('__cateHost')
  })

  it('keeps the page on its thread and adopts a thread the page created', async () => {
    const t = setup(chatSnapshot({ threadId: null }))
    const chats = createMobileChats(t.views, t.bridge)
    chats.open({ viewId: 'v', workspaceId: 'ws1', panelId: 'p1' })
    await tick()
    chats.page({ viewId: 'v', dark: true })
    expect(chats.navigation({ viewId: 'v', url: 'https://example.com/', committed: false })).toEqual({ allow: false })
    expect(chats.navigation({ viewId: 'v', url: 'http://127.0.0.1:4000/', committed: true })).toEqual({ allow: true })
    expect(chats.navigation({ viewId: 'v', url: 'http://127.0.0.1:4000/env/new', committed: true })).toEqual({ allow: true })
    await tick()
    expect(t.sent).toEqual([{ kind: 'adoptThread', threadId: 'new' }])
    // Until the session confirms, the adopted thread counts as bound.
    expect(chats.navigation({ viewId: 'v', url: 'http://127.0.0.1:4000/env/new', committed: false })).toEqual({ allow: true })
  })

  it('moves a page that left its thread back in place', async () => {
    const t = setup(chatSnapshot())
    const chats = createMobileChats(t.views, t.bridge)
    chats.open({ viewId: 'v', workspaceId: 'ws1', panelId: 'p1' })
    await tick()
    chats.page({ viewId: 'v', dark: true })
    expect(chats.navigation({ viewId: 'v', url: 'http://127.0.0.1:4000/', committed: true })).toEqual({ allow: false })
    const scripts = t.events.filter((e) => e.event.kind === 'script').map((e) => (e.event as { script: string }).script)
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toContain('__cateRouter')
    expect(scripts[0]).toContain('"/env/th1"')
  })

  it('follows a thread another client moved the panel to in place', async () => {
    const t = setup(chatSnapshot())
    const chats = createMobileChats(t.views, t.bridge)
    chats.open({ viewId: 'v', workspaceId: 'ws1', panelId: 'p1' })
    await tick()
    chats.page({ viewId: 'v', dark: true })
    chats.navigation({ viewId: 'v', url: 'http://127.0.0.1:4000/env/th1', committed: true })
    t.set(chatSnapshot({ threadId: 'th2' }))
    await tick()
    const scripts = t.events.filter((e) => e.event.kind === 'script').map((e) => (e.event as { script: string }).script)
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toContain('router.navigate({ href: "/env/th2", replace: true })')
  })

  it('answers the page bridge for its token only', async () => {
    const t = setup(chatSnapshot())
    const chats = createMobileChats(t.views, t.bridge)
    chats.open({ viewId: 'v', workspaceId: 'ws1', panelId: 'p1' })
    await tick()
    const page = chats.page({ viewId: 'v', dark: true })!
    const token = /token: "([^"]+)"/.exec(page.script)![1]
    const message = (tokenValue: string) => `cate-chat-host:${JSON.stringify({ token: tokenValue, id: 'r1', action: 'relation-context', payload: { provider: null } })}`
    expect(await chats.hostMessage({ viewId: 'v', message: message('wrong') })).toBeNull()
    expect(await chats.hostMessage({ viewId: 'v', message: message(token) })).toBe('window.__cateHost?.reply("r1", "done", null)')
    expect(t.sent).toEqual([{ kind: 'relationContext', provider: null }])
  })
})
