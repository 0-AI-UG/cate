import { afterEach, describe, expect, it, vi } from 'vitest'
import { installClientIdentity } from '@client/connections'
import type { BrowserSnapshot, BrowserTab } from '@panels/browser/contract'
import type { MobileBridge, MobileViewEvent } from '../contract'
import { attachSessions } from '@client/host'
import { createMobileBrowsers } from './browser'
import { createMobileViews, type MobileViews } from './views'

let detach = () => {}
const created: MobileViews[] = []
// Views follow the attached sessions; a test's views close with it.
afterEach(() => {
  for (const views of created.splice(0)) views.get('v')?.close()
  detach()
})

const tick = () => new Promise((r) => setTimeout(r, 0))

installClientIdentity({ clientId: 'me', device: { name: 'phone', publicKey: 'k' }, features: [] } as never)

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
  detach = attachSessions({ get: (id: string) => (id === 'ws1' ? connection : undefined), subscribe: () => () => {} } as never)
  const events: Array<{ viewId: string; event: MobileViewEvent }> = []
  const bridge = (async (method: string, params: { viewId: string; json: string }) => {
    if (method === 'view.event') events.push({ viewId: params.viewId, event: JSON.parse(params.json) })
    return null
  }) as MobileBridge
  const set = (next: S) => {
    snapshot = next
    for (const l of listeners) l()
  }
  const views = createMobileViews(bridge)
  created.push(views)
  return { bridge, session, sent, events, set, views }
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
