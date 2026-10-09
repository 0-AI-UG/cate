import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPageBridge } from '@services/browser/contract'
import type { BrowserOp, BrowserSnapshot, BrowserTab } from '@panels/browser/contract'
import { BrowserPageHost, type BrowserGuest } from './pageHost'
import { registerSurface, runSurfaceRequest, subscribeDemandedSurfaces, demandedSurfaces } from '@client/host'
import { runCodeOp, runPageOp } from './surfaces'

function guest(id = 7): BrowserGuest & { url: string; loading: boolean; fire(type: string, detail?: object): void } {
  const element = document.createElement('div') as unknown as BrowserGuest & { url: string; loading: boolean; fire(type: string, detail?: object): void }
  Object.assign(element, {
    url: 'about:blank',
    loading: false,
    loadURL: vi.fn(function (this: { url: string }, url: string) { this.url = url }),
    goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), reloadIgnoringCache: vi.fn(),
    canGoBack: () => true, canGoForward: () => false,
    isLoading() { return element.loading },
    getURL() { return element.url },
    getTitle: () => 'Title',
    getWebContentsId: () => id,
    insertCSS: vi.fn(async () => ''),
    getZoomFactor: () => 1,
    setZoomFactor: vi.fn(),
    fire(type: string, detail: object = {}) { element.dispatchEvent(Object.assign(new Event(type), detail)) },
  })
  return element
}

const tab = (patch: Partial<BrowserTab> = {}): BrowserTab => ({ id: 't1', url: 'https://a.test/', title: '', favicon: null, pinned: false, nav: 0, navSource: null, ...patch })
const snapshot = (tabs: BrowserTab[]): BrowserSnapshot => ({
  tabs, activeTabId: tabs[0].id, activeSource: null, viewport: { preset: 'compact' },
  canGoBack: false, canGoForward: false, isLoading: false, loadError: null, crashed: false, downloads: [], agentCursor: null,
})

function setup(bridge: Partial<BrowserPageBridge> | null = null) {
  const sent: BrowserOp[] = []
  const host = new BrowserPageHost({
    panelId: 'p1',
    clientId: 'me',
    send: async (op) => { sent.push(op) },
    bridge: bridge as BrowserPageBridge | null,
    nextFrame: async () => {},
  })
  return { host, sent }
}

afterEach(() => vi.useRealTimers())

describe('BrowserPageHost', () => {
  it('follows navigation from elsewhere and never reports the load it made', () => {
    const { host, sent } = setup()
    host.update(snapshot([tab()]))
    const webview = guest()
    host.attachGuest('t1', webview)
    webview.fire('dom-ready')

    host.update(snapshot([tab({ url: 'https://b.test/', nav: 1, navSource: 'other' })]))
    expect(webview.loadURL).toHaveBeenCalledWith('https://b.test/')
    webview.fire('did-navigate', { url: 'https://b.test/login' })
    expect(sent.filter((op) => op.kind === 'reportNavigation')).toEqual([])
    // Only its history state, so every client's Back reflects the page.
    expect(sent.at(-1)).toEqual({ kind: 'reportLoad', tabId: 't1', canGoBack: true, canGoForward: false })
    webview.fire('did-stop-loading')

    // A navigation of this client's own page is reported.
    webview.fire('did-navigate', { url: 'https://b.test/next' })
    expect(sent.at(-1)).toMatchObject({ kind: 'reportNavigation', tabId: 't1', url: 'https://b.test/next', canGoBack: true })

    // Its own report coming back is not loaded again.
    vi.mocked(webview.loadURL).mockClear()
    host.update(snapshot([tab({ url: 'https://b.test/next', nav: 2, navSource: 'me' })]))
    expect(webview.loadURL).not.toHaveBeenCalled()
  })

  it('loads a navigation that arrived before the guest was ready once it is', () => {
    const { host } = setup()
    host.update(snapshot([tab()]))
    const webview = guest()
    host.attachGuest('t1', webview)
    host.update(snapshot([tab({ url: 'https://c.test/', nav: 1 })]))
    expect(webview.loadURL).not.toHaveBeenCalled()
    webview.fire('dom-ready')
    expect(webview.loadURL).toHaveBeenCalledWith('https://c.test/')
  })

  it('answers page.ready once the tab followed nav and stopped loading', async () => {
    const { host } = setup()
    host.update(snapshot([tab()]))
    const webview = guest()
    host.attachGuest('t1', webview)
    webview.fire('dom-ready')
    webview.loading = true
    const ready = host.ready({ tabId: 't1', nav: 1 })
    host.update(snapshot([tab({ url: 'https://d.test/', nav: 1 })]))
    webview.loading = false
    webview.fire('did-stop-loading')
    await expect(ready).resolves.toEqual({ url: 'https://d.test/', title: 'Title' })
  })

  it('shows the active tab for page.ready when its page is not mounted yet', async () => {
    const revealed: string[] = []
    const host = new BrowserPageHost({
      panelId: 'p1', clientId: 'me', send: async () => {}, bridge: null, nextFrame: async () => {},
      reveal: (tabId) => {
        revealed.push(tabId)
        host.show(tabId)
        const webview = guest()
        webview.url = 'https://b.test/'
        host.attachGuest(tabId, webview)
        webview.fire('dom-ready')
      },
    })
    host.update({ ...snapshot([tab(), tab({ id: 't2', url: 'https://b.test/' })]), activeTabId: 't2' })
    host.show('t1')
    await expect(host.ready({ tabId: 't2', nav: 0 })).resolves.toEqual({ url: 'https://b.test/', title: 'Title' })
    expect(revealed).toEqual(['t2'])
  })

  it('runs page-driver methods on the exact guest and stages uploads', async () => {
    const bridge = {
      attach: vi.fn(async () => {}),
      execute: vi.fn(async () => ({ result: 'ok' })),
      stageUpload: vi.fn(async () => '/tmp/staged/file.txt'),
    }
    const sent: BrowserOp[] = []
    const host = new BrowserPageHost({
      panelId: 'p1', clientId: 'me', send: async (op) => { sent.push(op) }, bridge: bridge as never, nextFrame: async () => {},
      fetchUpload: async () => ({ name: 'file.txt', bytes: new Uint8Array([1]) }),
    })
    host.update(snapshot([tab()]))
    const webview = guest(42)
    host.attachGuest('t1', webview)
    webview.fire('dom-ready')
    await expect(host.execute({ tabId: 't1', method: 'getAXState', args: { tabId: 't1' } })).resolves.toEqual({ result: 'ok' })
    expect(bridge.execute).toHaveBeenCalledWith({ webContentsId: 42, panelId: 'p1', tabId: 't1' }, 'getAXState', { tabId: 't1' })
    await host.execute({ tabId: 't1', method: 'upload', args: { target: 3, filePath: '/remote/file.txt' } })
    expect(bridge.execute).toHaveBeenLastCalledWith(expect.anything(), 'upload', { target: 3, filePath: '/tmp/staged/file.txt' })
    await expect(host.execute({ tabId: 'other', method: 'click', args: {} })).rejects.toThrow('browser-tab-changed')
  })

  it('shows the session\'s active tab before a page operation runs on it', async () => {
    const bridge = { attach: vi.fn(async () => {}), execute: vi.fn(async () => ({ result: 'ok' })) }
    const revealed: string[] = []
    const host = new BrowserPageHost({
      panelId: 'p1', clientId: 'me', send: async () => {}, bridge: bridge as never, nextFrame: async () => {},
      reveal: (tabId) => { revealed.push(tabId); host.show(tabId) },
    })
    host.update({ ...snapshot([tab(), tab({ id: 't2', url: 'https://b.test/' })]), activeTabId: 't2' })
    host.show('t1')
    for (const [id, webContentsId] of [['t1', 1], ['t2', 2]] as const) {
      const webview = guest(webContentsId)
      host.attachGuest(id, webview)
      webview.fire('dom-ready')
    }
    await expect(host.execute({ tabId: 't2', method: 'click', args: {} })).resolves.toEqual({ result: 'ok' })
    expect(revealed).toEqual(['t2'])
    expect(bridge.execute).toHaveBeenCalledWith({ webContentsId: 2, panelId: 'p1', tabId: 't2' }, 'click', {})
    await expect(host.execute({ tabId: 't1', method: 'click', args: {} })).rejects.toThrow('browser-tab-changed')
  })

  it('offers to save a submitted password through the runtime', async () => {
    const save = vi.fn(async () => ({}))
    const confirmSave = vi.fn(async () => true)
    const host = new BrowserPageHost({
      panelId: 'p1', clientId: 'me', send: async () => {}, bridge: null, confirmSave,
      passwords: { suggestions: async () => [], forFill: async () => null, saveDisposition: async () => 'create', save },
    })
    host.update(snapshot([tab()]))
    const webview = guest()
    host.attachGuest('t1', webview)
    webview.fire('ipc-message', { channel: 'cate-browser-password-submit', args: [{ origin: 'https://a.test', username: 'me', password: 'pw' }] })
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ origin: 'https://a.test', password: 'pw' })))
    expect(confirmSave).toHaveBeenCalledWith('Save the password for a.test (me)?')
  })
})

describe('browser surface requests', () => {
  it('route page operations to the mounted panel and wait for one to mount', async () => {
    const { host } = setup({ attach: vi.fn(async () => {}), execute: vi.fn(async () => ({ result: 1 })) })
    host.update(snapshot([tab()]))
    const webview = guest()
    host.attachGuest('t1', webview)
    webview.fire('dom-ready')
    const demands: number[] = []
    const stopDemand = subscribeDemandedSurfaces(() => demands.push(demandedSurfaces().size))
    const pending = runSurfaceRequest('ws', { requestId: 1, panelId: 'p1', op: 'page.execute', args: { tabId: 't1', method: 'getAXState', args: {} } })
    const unregister = registerSurface('ws', 'p1', (request) => runPageOp(host, request))
    await expect(pending).resolves.toEqual({ result: 1 })
    expect(demands).toEqual([1, 0])
    unregister()
    stopDemand()
  })

  it('fail with no-renderer when the panel never mounts', async () => {
    vi.useFakeTimers()
    const pending = runSurfaceRequest('ws', { requestId: 2, panelId: 'missing', op: 'page.ready', args: { tabId: 't', nav: 0 } })
    const settled = expect(pending).rejects.toMatchObject({ code: 'no-renderer' })
    await vi.advanceTimersByTimeAsync(5_000)
    await settled
  })

  it('send a running cell\'s calls to the runtime that started it', async () => {
    let handler: ((call: { cellId: string; method: string; args: Record<string, unknown> }) => Promise<unknown>) | undefined
    const call = vi.fn(async () => 'answer')
    const bridge = {
      onCodeCall: (next: typeof handler) => { handler = next; return () => {} },
      runCode: vi.fn(async ({ cellId }: { cellId: string }) => ({ content: [{ type: 'text', text: String(await handler!({ cellId, method: 'listTabs', args: {} })) }] })),
    }
    const result = await runCodeOp(
      { bridge: bridge as never, browserCode: { call } as never },
      { requestId: 3, panelId: null, op: 'code.run', args: { key: 'k', cellId: 'c1', code: '1', deadlineMs: 1000 } },
    )
    expect(result).toEqual({ content: [{ type: 'text', text: 'answer' }] })
    expect(call).toHaveBeenCalledWith({ cellId: 'c1', method: 'listTabs', args: {} })
    await expect(handler!({ cellId: 'c1', method: 'listTabs', args: {} })).rejects.toThrow('browser-code-cell-cancelled')
  })
})
