import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPageBridge } from '@services/browser/contract'
import type { BrowserOp, BrowserSnapshot, BrowserTab } from '@panels/browser/contract'
import { BrowserPageHost, type BrowserGuest } from '@panels/browser/desktop'
import { registerSurface, runSurfaceRequest, subscribeDemandedSurfaces, demandedSurfaces } from '@client/host'
import { createPageOps, type PageOpsDeps } from '@services/browser/desktop/renderer'
import { runPageOp } from './surfaces'

/** One `page.*` request on a host, through this client's page ops. */
function pageOp(host: BrowserPageHost, op: string, args: unknown, deps: PageOpsDeps): Promise<unknown> {
  return runPageOp({ host, ops: createPageOps(deps) }, { requestId: 0, panelId: host.panelId, op, args })
}

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

const tab = (patch: Partial<BrowserTab> = {}): BrowserTab => ({ id: 't1', url: 'https://a.test/', title: '', favicon: null, pinned: false, nav: 0, navSource: null, openedBy: null, ...patch })
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
    bridge: bridge ? { onDialog: () => () => {}, ...bridge } as BrowserPageBridge : null,
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

  it('loads the URL the page already shows when the session is asked for it, not when another page went there', () => {
    const { host } = setup()
    host.update(snapshot([tab()]))
    const webview = guest()
    host.attachGuest('t1', webview)
    webview.fire('dom-ready')
    webview.url = 'https://a.test/'

    host.update(snapshot([tab({ nav: 1, navSource: 'other' })]))
    expect(webview.loadURL).not.toHaveBeenCalled()
    // `goto` or the address bar: the page loads again.
    host.update(snapshot([tab({ nav: 2, navSource: null })]))
    expect(webview.loadURL).toHaveBeenCalledWith('https://a.test/')
  })

  it('restarts a hung page before loading a navigation and on reload', async () => {
    const restartIfHung = vi.fn(async () => true)
    const { host } = setup({ restartIfHung, attach: vi.fn(async () => {}) })
    host.update(snapshot([tab()]))
    const webview = guest()
    host.attachGuest('t1', webview)
    webview.fire('dom-ready')

    host.update(snapshot([tab({ url: 'https://b.test/', nav: 1 })]))
    expect(webview.loadURL).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(webview.loadURL).toHaveBeenCalledWith('https://b.test/'))
    expect(restartIfHung).toHaveBeenCalledWith({ webContentsId: 7, panelId: 'p1', tabId: 't1' })

    expect(await host.history({ tabId: 't1', action: 'reload' })).toEqual({ ok: true })
    expect(webview.reload).not.toHaveBeenCalled()
    restartIfHung.mockResolvedValue(false)
    expect(await host.history({ tabId: 't1', action: 'reload' })).toEqual({ ok: true })
    expect(webview.reload).toHaveBeenCalled()
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
      attach: vi.fn(async () => {}), onDialog: () => () => {},
      execute: vi.fn(async () => ({ result: 'ok' })),
      stageUpload: vi.fn(async () => '/tmp/staged/file.txt'),
    }
    const sent: BrowserOp[] = []
    const host = new BrowserPageHost({
      panelId: 'p1', clientId: 'me', send: async (op) => { sent.push(op) }, bridge: bridge as never, nextFrame: async () => {},
    })
    const fetchUpload = async () => ({ name: 'file.txt', bytes: new Uint8Array([1]) })
    const execute = (args: unknown) => pageOp(host, 'page.execute', args, { bridge: bridge as never, fetchUpload })
    host.update(snapshot([tab()]))
    const webview = guest(42)
    host.attachGuest('t1', webview)
    webview.fire('dom-ready')
    // A parked (off-screen) guest is flagged, so a screenshot fails at once.
    await execute({ tabId: 't1', method: 'getScreenshot', args: { tabId: 't1' } })
    expect(bridge.execute).toHaveBeenLastCalledWith(expect.anything(), 'getScreenshot', { tabId: 't1', _hidden: true })
    host.visible = true
    await expect(execute({ tabId: 't1', method: 'getAXState', args: { tabId: 't1' } })).resolves.toEqual({ result: 'ok' })
    expect(bridge.execute).toHaveBeenCalledWith({ webContentsId: 42, panelId: 'p1', tabId: 't1' }, 'getAXState', { tabId: 't1' })
    await execute({ tabId: 't1', method: 'upload', args: { target: 3, files: ['/remote/a.txt', '/remote/b.txt'] } })
    expect(bridge.stageUpload).toHaveBeenCalledTimes(2)
    expect(bridge.execute).toHaveBeenLastCalledWith(expect.anything(), 'upload', { target: 3, files: ['/tmp/staged/file.txt', '/tmp/staged/file.txt'] })
    await expect(execute({ tabId: 'other', method: 'click', args: {} })).rejects.toThrow('browser-tab-changed')
  })

  it('shows the session\'s active tab before a page operation runs on it', async () => {
    const bridge = { attach: vi.fn(async () => {}), onDialog: () => () => {}, execute: vi.fn(async () => ({ result: 'ok' })) }
    const revealed: string[] = []
    const host = new BrowserPageHost({
      panelId: 'p1', clientId: 'me', send: async () => {}, bridge: bridge as never, nextFrame: async () => {},
      reveal: (tabId) => { revealed.push(tabId); host.show(tabId) },
    })
    host.visible = true
    host.update({ ...snapshot([tab(), tab({ id: 't2', url: 'https://b.test/' })]), activeTabId: 't2' })
    host.show('t1')
    for (const [id, webContentsId] of [['t1', 1], ['t2', 2]] as const) {
      const webview = guest(webContentsId)
      host.attachGuest(id, webview)
      webview.fire('dom-ready')
    }
    await expect(pageOp(host, 'page.execute', { tabId: 't2', method: 'click', args: {} }, { bridge: bridge as never })).resolves.toEqual({ result: 'ok' })
    expect(revealed).toEqual(['t2'])
    expect(bridge.execute).toHaveBeenCalledWith({ webContentsId: 2, panelId: 'p1', tabId: 't2' }, 'click', {})
    await expect(pageOp(host, 'page.execute', { tabId: 't1', method: 'click', args: {} }, { bridge: bridge as never })).rejects.toThrow('browser-tab-changed')
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

describe('BrowserPageHost dialogs', () => {
  it('shows the dialog the shown page waits on and sends the person\'s answer', () => {
    let listener!: (event: { webContentsId: number; dialog: { id: string; type: 'prompt'; message: string; defaultPrompt?: string } | null }) => void
    const answerDialog = vi.fn(async () => {})
    const host = new BrowserPageHost({
      panelId: 'p1', clientId: 'me', send: async () => {}, nextFrame: async () => {},
      bridge: { onDialog: (next: typeof listener) => { listener = next; return () => {} }, answerDialog } as never,
    })
    host.update(snapshot([tab()]))
    host.attachGuest('t1', guest(42))
    listener({ webContentsId: 9, dialog: { id: 'd0', type: 'prompt', message: 'Not ours' } })
    expect(host.dialog).toBeNull()
    listener({ webContentsId: 42, dialog: { id: 'd1', type: 'prompt', message: 'Name?', defaultPrompt: 'x' } })
    expect(host.dialog).toMatchObject({ id: 'd1', message: 'Name?' })
    host.answerDialog(true, 'Ada')
    expect(answerDialog).toHaveBeenCalledWith(42, 'd1', { accept: true, text: 'Ada' })
    listener({ webContentsId: 42, dialog: null })
    expect(host.dialog).toBeNull()
  })
})

describe('browser surface requests', () => {
  it('route page operations to the mounted panel and wait for one to mount', async () => {
    const bridge = { attach: vi.fn(async () => {}), onDialog: () => () => {}, execute: vi.fn(async () => ({ result: 1 })) }
    const { host } = setup(bridge)
    host.update(snapshot([tab()]))
    const webview = guest()
    host.attachGuest('t1', webview)
    webview.fire('dom-ready')
    const demands: number[] = []
    const stopDemand = subscribeDemandedSurfaces(() => demands.push(demandedSurfaces().size))
    const pending = runSurfaceRequest('ws', { requestId: 1, panelId: 'p1', op: 'page.execute', args: { tabId: 't1', method: 'getAXState', args: {} } })
    const unregister = registerSurface('ws', 'p1', (request) => pageOp(host, request.op, request.args, { bridge: bridge as never }))
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
})
