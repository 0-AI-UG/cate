// =============================================================================
// browserDriver — renderer executor for the `cate.browser.*` reverse API.
//
// Drives handleBrowserMethod against a mocked app store + portalRegistry +
// screenshot IPC, covering: default target resolution (focused / first browser),
// explicit panelId (incl. panel-not-in-window), open-creates-a-panel, screenshot
// returning { path }, and a spread of the stable error vocabulary.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

const WS = 'ws-1'

// A live <webview> stand-in. Each test tweaks the nav predicates it needs.
function makeWebview(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getWebContentsId: vi.fn(() => 99),
    getURL: vi.fn(() => 'https://example.com/'),
    getTitle: vi.fn(() => 'Example'),
    loadURL: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    canGoBack: vi.fn(() => true),
    canGoForward: vi.fn(() => true),
    isLoading: vi.fn(() => false),
    executeJavaScript: vi.fn(async () => ({ ok: true })),
    ...overrides,
  }
}

const h = vi.hoisted(() => ({
  workspaces: [] as Array<{ id: string; panels: Record<string, { id: string; type: string; title: string; url?: string }> }>,
  activePanelId: null as string | null,
  createBrowser: vi.fn(() => 'created-browser-id'),
  updatePanelUrl: vi.fn(),
  webviews: new Map<string, ReturnType<typeof makeWebview>>(),
  screenshot: vi.fn(async () => ({ filePath: '/tmp/shot.png', dataUrl: 'data:image/png;base64,x' }) as { filePath: string; dataUrl: string } | null),
}))

vi.mock('../../stores/appStore', () => ({
  useAppStore: {
    getState: () => ({
      workspaces: h.workspaces,
      createBrowser: h.createBrowser,
      updatePanelUrl: h.updatePanelUrl,
    }),
  },
}))

vi.mock('../activePanel', () => ({
  getActivePanelId: () => h.activePanelId,
}))

vi.mock('../portalRegistry', () => ({
  portalRegistry: {
    get: (panelId: string) => h.webviews.get(panelId) ?? null,
  },
}))

import { handleBrowserMethod, findBrowserPanelId } from './browserDriver'

const M = (name: string) => `cate.browser.${name}`

beforeEach(() => {
  vi.clearAllMocks()
  h.activePanelId = null
  h.webviews = new Map()
  h.workspaces = [
    {
      id: WS,
      panels: {
        term: { id: 'term', type: 'terminal', title: 'Term' },
        b1: { id: 'b1', type: 'browser', title: 'Docs', url: 'https://docs.example/' },
      },
    },
  ]
  ;(globalThis as unknown as { window: { electronAPI: unknown } }).window = {
    electronAPI: { webviewScreenshot: h.screenshot },
  }
})

describe('target resolution', () => {
  it('defaults to the first browser panel when nothing is focused', async () => {
    const wv = makeWebview()
    h.webviews.set('b1', wv)
    const out = await handleBrowserMethod(WS, M('reload'), {})
    expect(out).toEqual({ ok: true })
    expect(wv.reload).toHaveBeenCalled()
  })

  it('prefers the focused browser over the first browser', async () => {
    // Add a second browser and make it the active panel.
    h.workspaces[0].panels.b2 = { id: 'b2', type: 'browser', title: 'App', url: 'https://app/' }
    h.activePanelId = 'b2'
    const first = makeWebview()
    const focused = makeWebview()
    h.webviews.set('b1', first)
    h.webviews.set('b2', focused)
    await handleBrowserMethod(WS, M('reload'), {})
    expect(focused.reload).toHaveBeenCalled()
    expect(first.reload).not.toHaveBeenCalled()
  })

  it('ignores a focused NON-browser panel and falls back to first browser', async () => {
    h.activePanelId = 'term'
    const wv = makeWebview()
    h.webviews.set('b1', wv)
    await handleBrowserMethod(WS, M('reload'), {})
    expect(wv.reload).toHaveBeenCalled()
  })

  it('routes to an explicit args.panelId', async () => {
    h.workspaces[0].panels.b2 = { id: 'b2', type: 'browser', title: 'App', url: 'https://app/' }
    const b1 = makeWebview()
    const b2 = makeWebview()
    h.webviews.set('b1', b1)
    h.webviews.set('b2', b2)
    await handleBrowserMethod(WS, M('reload'), { panelId: 'b2' })
    expect(b2.reload).toHaveBeenCalled()
    expect(b1.reload).not.toHaveBeenCalled()
  })

  it('rejects an explicit panelId that is not a browser in this window', async () => {
    const out = await handleBrowserMethod(WS, M('reload'), { panelId: 'term' })
    expect(out).toEqual({ ok: false, error: 'panel-not-in-window' })
  })

  it('rejects an explicit panelId absent from this window', async () => {
    const out = await handleBrowserMethod(WS, M('reload'), { panelId: 'ghost' })
    expect(out).toEqual({ ok: false, error: 'panel-not-in-window' })
  })

  it('reports webview-not-ready when the panel exists but no webview is registered', async () => {
    const out = await handleBrowserMethod(WS, M('reload'), {})
    expect(out).toEqual({ ok: false, error: 'webview-not-ready' })
  })
})

describe('open', () => {
  it('creates a browser panel when the workspace has none', async () => {
    h.workspaces[0].panels = { term: { id: 'term', type: 'terminal', title: 'Term' } }
    const out = await handleBrowserMethod(WS, M('open'), { url: 'https://new/' })
    expect(h.createBrowser).toHaveBeenCalledWith(WS, 'https://new/')
    expect(out).toEqual({ ok: true, result: { panelId: 'created-browser-id' } })
  })

  it('loads the URL into the existing browser and mirrors it to the store', async () => {
    const wv = makeWebview()
    h.webviews.set('b1', wv)
    const out = await handleBrowserMethod(WS, M('open'), { url: 'https://go/' })
    expect(wv.loadURL).toHaveBeenCalledWith('https://go/')
    expect(h.updatePanelUrl).toHaveBeenCalledWith(WS, 'b1', 'https://go/')
    expect(out).toEqual({ ok: true, result: { panelId: 'b1' } })
  })

  it('mirrors the URL to the store when the webview is not attached yet (succeeds)', async () => {
    const out = await handleBrowserMethod(WS, M('open'), { url: 'https://later/' })
    expect(h.updatePanelUrl).toHaveBeenCalledWith(WS, 'b1', 'https://later/')
    expect(out).toEqual({ ok: true, result: { panelId: 'b1' } })
  })

  it('requires a url', async () => {
    const out = await handleBrowserMethod(WS, M('open'), {})
    expect(out).toEqual({ ok: false, error: 'url-required' })
  })
})

describe('navigation + query', () => {
  it('rejects back when the webview cannot go back', async () => {
    h.webviews.set('b1', makeWebview({ canGoBack: vi.fn(() => false) }))
    const out = await handleBrowserMethod(WS, M('back'), {})
    expect(out).toEqual({ ok: false, error: 'cannot-go-back' })
  })

  it('rejects forward when the webview cannot go forward', async () => {
    h.webviews.set('b1', makeWebview({ canGoForward: vi.fn(() => false) }))
    const out = await handleBrowserMethod(WS, M('forward'), {})
    expect(out).toEqual({ ok: false, error: 'cannot-go-forward' })
  })

  it('current returns nav state and maps a start-page URL back to empty', async () => {
    h.webviews.set('b1', makeWebview({ getURL: vi.fn(() => 'cate://newtab') }))
    const out = await handleBrowserMethod(WS, M('current'), {})
    expect(out).toEqual({
      ok: true,
      result: { url: '', title: 'Example', canGoBack: true, canGoForward: true, loading: false },
    })
  })

  it('list reports every browser panel with focus + start-page normalization', async () => {
    h.workspaces[0].panels.b2 = { id: 'b2', type: 'browser', title: 'New Tab', url: 'cate://newtab' }
    h.activePanelId = 'b2'
    const out = await handleBrowserMethod(WS, M('list'), {})
    expect(out).toEqual({
      ok: true,
      result: {
        browsers: [
          { panelId: 'b1', title: 'Docs', url: 'https://docs.example/', focused: false },
          { panelId: 'b2', title: 'New Tab', url: '', focused: true },
        ],
      },
    })
  })

  it('reports no-browser for a nav call when the workspace has none', async () => {
    h.workspaces[0].panels = { term: { id: 'term', type: 'terminal', title: 'Term' } }
    const out = await handleBrowserMethod(WS, M('reload'), {})
    expect(out).toEqual({ ok: false, error: 'no-browser' })
  })
})

describe('screenshot', () => {
  it('returns { path } from the webviewScreenshot IPC', async () => {
    const wv = makeWebview()
    h.webviews.set('b1', wv)
    const out = await handleBrowserMethod(WS, M('screenshot'), {})
    expect(h.screenshot).toHaveBeenCalledWith(99)
    expect(out).toEqual({ ok: true, result: { path: '/tmp/shot.png' } })
  })

  it('reports screenshot-failed when the IPC yields nothing', async () => {
    h.webviews.set('b1', makeWebview())
    h.screenshot.mockResolvedValueOnce(null)
    const out = await handleBrowserMethod(WS, M('screenshot'), {})
    expect(out).toEqual({ ok: false, error: 'screenshot-failed' })
  })
})

describe('snapshot / click / type', () => {
  it('snapshot returns the injected script result', async () => {
    const snap = { url: 'https://example.com/', title: 'Example', refs: [{ ref: '@e1', role: 'button', name: 'Go' }] }
    h.webviews.set('b1', makeWebview({ executeJavaScript: vi.fn(async () => snap) }))
    const out = await handleBrowserMethod(WS, M('snapshot'), {})
    expect(out).toEqual({ ok: true, result: snap })
  })

  it('click requires a ref', async () => {
    h.webviews.set('b1', makeWebview())
    const out = await handleBrowserMethod(WS, M('click'), {})
    expect(out).toEqual({ ok: false, error: 'ref-required' })
  })

  it('click surfaces a stale ref from the page', async () => {
    h.webviews.set('b1', makeWebview({ executeJavaScript: vi.fn(async () => ({ error: 'stale-ref' })) }))
    const out = await handleBrowserMethod(WS, M('click'), { ref: '@e9' })
    expect(out).toEqual({ ok: false, error: 'stale-ref' })
  })

  it('click passes the ref via JSON.stringify (never interpolated raw)', async () => {
    const exec = vi.fn(async (_code: string) => ({ ok: true }))
    h.webviews.set('b1', makeWebview({ executeJavaScript: exec }))
    await handleBrowserMethod(WS, M('click'), { ref: '@e2' })
    const code = exec.mock.calls[0][0] as string
    expect(code).toContain('"@e2"')
  })

  it('type dispatches with the given text and succeeds', async () => {
    const exec = vi.fn(async (_code: string) => ({ ok: true }))
    h.webviews.set('b1', makeWebview({ executeJavaScript: exec }))
    const out = await handleBrowserMethod(WS, M('type'), { ref: '@e1', text: 'hi "there"' })
    expect(out).toEqual({ ok: true })
    const code = exec.mock.calls[0][0] as string
    expect(code).toContain(JSON.stringify('hi "there"'))
  })
})

describe('findBrowserPanelId', () => {
  it('returns the first browser panel id', () => {
    expect(findBrowserPanelId(WS)).toBe('b1')
  })
  it('returns null for an unknown workspace', () => {
    expect(findBrowserPanelId('nope')).toBeNull()
  })
})
