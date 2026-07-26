// @vitest-environment jsdom
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

function browserPanel(id: string, title: string, url: string, placementGroupId?: string) {
  const activeTabId = `${id}-tab`
  return {
    id,
    type: 'browser',
    title,
    tabs: [{ id: activeTabId, url, title: '' }],
    activeTabId,
    ...(placementGroupId ? { placementGroupId } : {}),
  }
}

// A live <webview> stand-in. Each test tweaks the nav predicates it needs.
function makeWebview(overrides: Partial<Record<string, unknown>> = {}) {
  let currentUrl = 'https://example.com/'
  const listeners = new Map<string, Set<(event: { url?: string }) => void>>()
  const emit = (type: string, url: string) => {
    currentUrl = url
    for (const listener of listeners.get(type) ?? []) listener({ url })
  }
  return {
    getWebContentsId: vi.fn(() => 99),
    getURL: vi.fn(() => currentUrl),
    getTitle: vi.fn(() => 'Example'),
    loadURL: vi.fn((url: string) => queueMicrotask(() => emit('did-navigate', url))),
    reload: vi.fn(),
    isLoading: vi.fn(() => false),
    goBack: vi.fn(),
    goForward: vi.fn(),
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => false),
    addEventListener: vi.fn((type: string, listener: (event: { url?: string }) => void) => {
      const current = listeners.get(type) ?? new Set()
      current.add(listener)
      listeners.set(type, current)
    }),
    removeEventListener: vi.fn((type: string, listener: (event: { url?: string }) => void) => {
      listeners.get(type)?.delete(listener)
    }),
    executeJavaScript: vi.fn(async () => ({ ok: true })),
    sendInputEvent: vi.fn(async (_e: { type: string; keyCode: string }) => {}),
    ...overrides,
  }
}

const h = vi.hoisted(() => ({
  workspaces: [] as Array<{ id: string; panels: Record<string, { id: string; type: string; title: string; tabs?: Array<{ id: string; url: string; title: string }>; activeTabId?: string; placementGroupId?: string }> }>,
  activePanelId: null as string | null,
  createBrowser: vi.fn(() => 'created-browser-id'),
  updateBrowserActiveTabUrl: vi.fn(),
  webviews: new Map<string, ReturnType<typeof makeWebview>>(),
  controllers: new Map<string, { navigate: (url: string) => void }>(),
  screenshot: vi.fn(async () => ({ filePath: '/tmp/shot.png', dataUrl: 'data:image/png;base64,x' }) as { filePath: string; dataUrl: string } | null),
  browserControl: vi.fn(async (req: Record<string, unknown>) => (
    req.op === 'playwright'
      ? { error: 'playwright-unavailable' }
      : { filePath: '/tmp/full.png' }
  ) as Record<string, unknown>),
}))

vi.mock('../../stores/appStore', () => ({
  useAppStore: {
    getState: () => ({
      workspaces: h.workspaces,
      createBrowser: h.createBrowser,
      updateBrowserActiveTabUrl: h.updateBrowserActiveTabUrl,
    }),
  },
}))

vi.mock('../activePanel', () => ({
  getActivePanelId: () => h.activePanelId,
}))

const BACKGROUND_PLACEMENT = { target: 'canvas', canvasPanelId: 'canvas-1', focus: false }
vi.mock('../workspace/canvasAccess', () => ({
  placementForBackgroundPanel: (_workspaceId: string, placementGroupId?: string) => ({
    ...BACKGROUND_PLACEMENT,
    ...(placementGroupId ? { placementGroupId } : {}),
  }),
}))

vi.mock('../portalRegistry', () => ({
  portalRegistry: {
    get: (panelId: string) => h.webviews.get(panelId) ?? null,
    getController: (panelId: string) => h.controllers.get(panelId) ?? null,
  },
}))

import { handleBrowserMethod, findBrowserPanelId } from './browserDriver'

const M = (name: string) => `cate.browser.${name}`

beforeEach(() => {
  vi.clearAllMocks()
  h.activePanelId = null
  h.webviews = new Map()
  h.controllers = new Map()
  h.workspaces = [
    {
      id: WS,
      panels: {
        term: { id: 'term', type: 'terminal', title: 'Term' },
        b1: browserPanel('b1', 'Docs', 'https://docs.example/'),
      },
    },
  ]
  ;(globalThis as unknown as { window: { electronAPI: unknown } }).window = {
    electronAPI: { webviewScreenshot: h.screenshot, browserControl: h.browserControl },
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
    h.workspaces[0].panels.b2 = browserPanel('b2', 'App', 'https://app/')
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
    h.workspaces[0].panels.b2 = browserPanel('b2', 'App', 'https://app/')
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

  // The two "no webview" cases are deliberately different errors: a MOUNTED
  // panel whose guest is still coming up is worth retrying (webview-not-ready);
  // a panel nothing is rendering never will be (panel-not-mounted).
  it('reports panel-not-mounted when nothing is rendering the panel', async () => {
    const out = await handleBrowserMethod(WS, M('reload'), {})
    expect(out).toEqual({ ok: false, error: 'panel-not-mounted' })
  })

  it('reports webview-not-ready when the panel is mounted but its guest is not up yet', async () => {
    h.controllers.set('b1', { navigate: vi.fn() })
    const out = await handleBrowserMethod(WS, M('reload'), {})
    expect(out).toEqual({ ok: false, error: 'webview-not-ready' })
  })
})

describe('open', () => {
  it('uses only a browser from the same placement group', async () => {
    h.workspaces[0].panels.grouped = browserPanel('grouped', 'Grouped', 'https://old/', 'group-1')
    const globalWebview = makeWebview()
    const groupedWebview = makeWebview()
    h.webviews.set('b1', globalWebview)
    h.webviews.set('grouped', groupedWebview)

    await handleBrowserMethod(WS, M('open'), {
      url: 'https://grouped/',
      placementGroupId: 'group-1',
    })

    expect(groupedWebview.loadURL).toHaveBeenCalledWith('https://grouped/')
    expect(globalWebview.loadURL).not.toHaveBeenCalled()
  })

  it('creates a browser for a new group instead of reusing another group', async () => {
    h.workspaces[0].panels.b1 = browserPanel('b1', 'Other iteration', 'https://old/', 'group-1')
    const webview = makeWebview()
    setTimeout(() => h.webviews.set('created-browser-id', webview), 10)

    await handleBrowserMethod(WS, M('open'), {
      url: 'https://grouped/',
      placementGroupId: 'group-2',
    })

    expect(h.createBrowser).toHaveBeenCalledWith(WS, 'https://grouped/', undefined, {
      ...BACKGROUND_PLACEMENT,
      placementGroupId: 'group-2',
    })
  })

  it('creates a browser panel when the workspace has none', async () => {
    h.workspaces[0].panels = { term: { id: 'term', type: 'terminal', title: 'Term' } }
    const webview = makeWebview()
    setTimeout(() => h.webviews.set('created-browser-id', webview), 10)
    const out = await handleBrowserMethod(WS, M('open'), { url: 'https://new/' })
    expect(h.createBrowser).toHaveBeenCalledWith(WS, 'https://new/', undefined, BACKGROUND_PLACEMENT)
    expect(webview.loadURL).toHaveBeenCalledWith('https://new/')
    expect(out).toEqual({ ok: true, result: { panelId: 'created-browser-id', url: 'https://new/' } })
  })

  it('creates a new browser when requested even if the group already has one', async () => {
    const existing = makeWebview()
    const created = makeWebview()
    h.webviews.set('b1', existing)
    setTimeout(() => h.webviews.set('created-browser-id', created), 10)

    const out = await handleBrowserMethod(WS, M('open'), { url: 'https://new/', newPanel: true })

    expect(h.createBrowser).toHaveBeenCalledWith(WS, 'https://new/', undefined, BACKGROUND_PLACEMENT)
    expect(existing.loadURL).not.toHaveBeenCalled()
    expect(created.loadURL).toHaveBeenCalledWith('https://new/')
    expect(out).toEqual({ ok: true, result: { panelId: 'created-browser-id', url: 'https://new/' } })
  })

  it('loads the URL into the existing browser and updates the active tab', async () => {
    const wv = makeWebview()
    h.webviews.set('b1', wv)
    const out = await handleBrowserMethod(WS, M('open'), { url: 'https://go/' })
    expect(wv.loadURL).toHaveBeenCalledWith('https://go/')
    expect(h.updateBrowserActiveTabUrl).toHaveBeenCalledWith(WS, 'b1', 'https://go/')
    expect(out).toEqual({ ok: true, result: { panelId: 'b1', url: 'https://go/' } })
  })

  it('does not report open success until the destination navigation commits', async () => {
    const listeners = new Map<string, Set<(event: { url?: string }) => void>>()
    const webview = makeWebview({
      loadURL: vi.fn(),
      addEventListener: vi.fn((type: string, listener: (event: { url?: string }) => void) => {
        const current = listeners.get(type) ?? new Set()
        current.add(listener)
        listeners.set(type, current)
      }),
      removeEventListener: vi.fn((type: string, listener: (event: { url?: string }) => void) => {
        listeners.get(type)?.delete(listener)
      }),
    })
    h.webviews.set('b1', webview)

    let settled = false
    const dataUrl = 'data:text/html,%3Ch1%3EOne%3C%2Fh1%3E'
    const pending = handleBrowserMethod(WS, M('open'), { url: dataUrl }).then((outcome) => {
      settled = true
      return outcome
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    for (const listener of listeners.get('did-navigate') ?? []) listener({ url: dataUrl })
    await expect(pending).resolves.toEqual({
      ok: true,
      result: { panelId: 'b1', url: dataUrl },
    })
  })

  it('waits for an unattached webview before reporting success', async () => {
    const webview = makeWebview()
    setTimeout(() => h.webviews.set('b1', webview), 10)
    const out = await handleBrowserMethod(WS, M('open'), { url: 'https://later/' })
    expect(h.updateBrowserActiveTabUrl).toHaveBeenCalledWith(WS, 'b1', 'https://later/')
    expect(webview.loadURL).toHaveBeenCalledWith('https://later/')
    expect(out).toEqual({ ok: true, result: { panelId: 'b1', url: 'https://later/' } })
  })

  it('requires a url', async () => {
    const out = await handleBrowserMethod(WS, M('open'), {})
    expect(out).toEqual({ ok: false, error: 'url-required' })
  })

  it('revives a start-page browser panel through its registered controller', async () => {
    // b1 is mounted but has NO webview (its start page renders instead); its
    // registered navigator is what mounts one. Regression: open used to wait 3s
    // for a webview that could never appear and fail webview-not-ready forever.
    const navigate = vi.fn(() => {
      setTimeout(() => h.webviews.set('b1', makeWebview()), 5)
    })
    h.controllers.set('b1', { navigate })
    const out = await handleBrowserMethod(WS, M('open'), { url: 'https://revive/' })
    expect(navigate).toHaveBeenCalledWith('https://revive/')
    expect(out).toEqual({ ok: true, result: { panelId: 'b1', url: 'https://revive/' } })
  })

  it('returns the resolved url alongside panelId for every branch (the { panelId, url } contract)', async () => {
    // Regression: open used to return { panelId } only, so `cate browser open`
    // printed 'ok' instead of the URL. Every branch must echo the loaded URL.

    // Branch 1: existing browser with a live webview.
    h.webviews.set('b1', makeWebview())
    const loaded = await handleBrowserMethod(WS, M('open'), { url: 'https://go/' })
    expect(loaded).toEqual({ ok: true, result: { panelId: 'b1', url: 'https://go/' } })

    // Branch 2: existing browser panel whose webview attaches on the next render.
    h.webviews = new Map()
    setTimeout(() => h.webviews.set('b1', makeWebview()), 10)
    const pending = await handleBrowserMethod(WS, M('open'), { url: 'https://later/' })
    expect(pending).toEqual({ ok: true, result: { panelId: 'b1', url: 'https://later/' } })

    // Branch 3: no browser panel — the driver creates one.
    h.workspaces[0].panels = { term: { id: 'term', type: 'terminal', title: 'Term' } }
    setTimeout(() => h.webviews.set('created-browser-id', makeWebview()), 10)
    const created = await handleBrowserMethod(WS, M('open'), { url: 'https://new/' })
    expect(created).toEqual({ ok: true, result: { panelId: 'created-browser-id', url: 'https://new/' } })
  })
})

describe('navigation + query', () => {
  // `list` stays absent on purpose: cate.panel.list is the one panel-enumeration
  // surface. back/forward/current ARE part of the surface now.
  it('list stays unsupported (panel.list is the enumeration surface)', async () => {
    h.webviews.set('b1', makeWebview())
    expect(await handleBrowserMethod(WS, M('list'), {})).toEqual({ ok: false, error: 'unsupported' })
  })

  it('current reports url, title and history state', async () => {
    h.webviews.set('b1', makeWebview())
    const out = await handleBrowserMethod(WS, M('current'), {})
    expect(out).toEqual({
      ok: true,
      result: {
        panelId: 'b1',
        url: 'https://example.com/',
        title: 'Example',
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
    })
  })

  it('back and forward refuse to move when there is no history', async () => {
    h.webviews.set('b1', makeWebview())
    expect(await handleBrowserMethod(WS, M('back'), {})).toEqual({ ok: false, error: 'no-history' })
    expect(await handleBrowserMethod(WS, M('forward'), {})).toEqual({ ok: false, error: 'no-history' })
  })

  it('back and forward wait for navigation and report the destination URL', async () => {
    let currentUrl = 'https://second.example/'
    const listeners = new Map<string, Set<(event: { url?: string }) => void>>()
    const emit = (type: string, url: string) => {
      currentUrl = url
      for (const listener of listeners.get(type) ?? []) listener({ url })
    }
    const wv = makeWebview({
      getURL: vi.fn(() => currentUrl),
      canGoBack: () => true,
      canGoForward: () => true,
      addEventListener: vi.fn((type: string, listener: (event: { url?: string }) => void) => {
        const current = listeners.get(type) ?? new Set()
        current.add(listener)
        listeners.set(type, current)
      }),
      removeEventListener: vi.fn((type: string, listener: (event: { url?: string }) => void) => {
        listeners.get(type)?.delete(listener)
      }),
      goBack: vi.fn(() => queueMicrotask(() => emit('did-navigate', 'https://first.example/'))),
      goForward: vi.fn(() => queueMicrotask(() => emit('did-navigate', 'https://second.example/'))),
    })
    h.webviews.set('b1', wv)
    expect(await handleBrowserMethod(WS, M('back'), {}))
      .toEqual({ ok: true, result: { url: 'https://first.example/' } })
    expect(wv.goBack).toHaveBeenCalled()
    expect(await handleBrowserMethod(WS, M('forward'), {}))
      .toEqual({ ok: true, result: { url: 'https://second.example/' } })
    expect(wv.goForward).toHaveBeenCalled()
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
    expect(h.screenshot).toHaveBeenCalledWith(99, { wantDataUrl: false, saveTo: 'temp' })
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
    expect(out).toEqual({ ok: false, error: 'ref-or-locator-required' })
  })

  it('click surfaces a stale ref from the page', async () => {
    h.webviews.set('b1', makeWebview({ executeJavaScript: vi.fn(async () => ({ error: 'stale-ref' })) }))
    const out = await handleBrowserMethod(WS, M('click'), { ref: '@e9' })
    expect(out).toEqual({ ok: false, error: 'stale-ref' })
  })

  it('click passes the ref via JSON.stringify (never interpolated raw)', async () => {
    const exec = vi.fn(async (_code: string) => ({ ok: true, x: 5, y: 5, rect: '0:0:10:10' }))
    const wv = makeWebview({ executeJavaScript: exec })
    h.webviews.set('b1', wv)
    await handleBrowserMethod(WS, M('click'), { ref: '@e2' })
    const code = exec.mock.calls[0][0] as string
    expect(code).toContain('"@e2"')
    expect(wv.sendInputEvent.mock.calls.map((call) => call[0].type)).toEqual(['mouseMove', 'mouseDown', 'mouseUp'])
  })

  it('uses the live guest for semantic click even when Playwright is attached', async () => {
    const wv = makeWebview({
      executeJavaScript: vi.fn(async () => ({ ok: true, x: 10, y: 20, rect: '0:0:20:20' })),
    })
    h.webviews.set('b1', wv)
    h.browserControl.mockResolvedValueOnce({ ok: true })

    const out = await handleBrowserMethod(WS, M('click'), { ref: '@s1e1' })

    expect(out).toEqual({ ok: true, result: { ref: '@s1e1' } })
    expect(h.browserControl).not.toHaveBeenCalled()
    expect(wv.sendInputEvent.mock.calls.map((call) => call[0].type))
      .toEqual(['mouseMove', 'mouseDown', 'mouseUp'])
  })

  it('type uses the trusted guest input target and succeeds', async () => {
    const exec = vi.fn(async (_code: string) => ({ ok: true, x: 5, y: 5, rect: '0:0:10:10' }))
    const wv = makeWebview({ executeJavaScript: exec })
    h.webviews.set('b1', wv)
    const out = await handleBrowserMethod(WS, M('type'), { ref: '@e1', text: 'hi "there"' })
    expect(out).toEqual({ ok: true, result: { ref: '@e1' } })
    expect(h.browserControl).toHaveBeenCalledWith({
      op: 'input',
      input: 'insertText',
      text: 'hi "there"',
      delay: 0,
      webContentsId: 99,
    })
  })
})

describe('webview failure + error paths', () => {
  it('type requires a ref', async () => {
    h.webviews.set('b1', makeWebview())
    const out = await handleBrowserMethod(WS, M('type'), { text: 'hi' })
    expect(out).toEqual({ ok: false, error: 'ref-or-locator-required' })
  })

  it('type surfaces a stale ref from the page', async () => {
    h.webviews.set('b1', makeWebview({ executeJavaScript: vi.fn(async () => ({ error: 'stale-ref' })) }))
    const out = await handleBrowserMethod(WS, M('type'), { ref: '@e9', text: 'hi' })
    expect(out).toEqual({ ok: false, error: 'stale-ref' })
  })

  it('reports unsupported for an unknown method', async () => {
    h.webviews.set('b1', makeWebview())
    const out = await handleBrowserMethod(WS, M('frobnicate'), {})
    expect(out).toEqual({ ok: false, error: 'unsupported' })
  })

  it('maps a throwing executeJavaScript to webview-not-ready (snapshot)', async () => {
    h.webviews.set('b1', makeWebview({ executeJavaScript: vi.fn(async () => { throw new Error('guest gone') }) }))
    const out = await handleBrowserMethod(WS, M('snapshot'), {})
    expect(out).toEqual({ ok: false, error: 'webview-not-ready' })
  })

  it('maps a throwing executeJavaScript to webview-not-ready (click)', async () => {
    h.webviews.set('b1', makeWebview({ executeJavaScript: vi.fn(async () => { throw new Error('guest gone') }) }))
    const out = await handleBrowserMethod(WS, M('click'), { ref: '@e1' })
    expect(out).toEqual({ ok: false, error: 'webview-not-ready' })
  })

  it('open maps a throwing loadURL to webview-not-ready', async () => {
    h.webviews.set('b1', makeWebview({ loadURL: vi.fn(() => { throw new Error('guest gone') }) }))
    const out = await handleBrowserMethod(WS, M('open'), { url: 'https://go/' })
    expect(out).toEqual({ ok: false, error: 'webview-not-ready' })
  })

  it('reports screenshot-failed when the IPC throws', async () => {
    h.webviews.set('b1', makeWebview())
    h.screenshot.mockRejectedValueOnce(new Error('capture boom'))
    const out = await handleBrowserMethod(WS, M('screenshot'), {})
    expect(out).toEqual({ ok: false, error: 'screenshot-failed' })
  })
})

// -----------------------------------------------------------------------------
// The injected page scripts (SNAPSHOT_JS / clickJs / typeJs) are module-private
// strings that only ever run inside the guest via executeJavaScript, so no other
// test exercises their DOM logic. Here we run them through the REAL code path: a
// fake webview whose executeJavaScript eval's the passed source against this
// file's jsdom document. jsdom's getBoundingClientRect returns all-zero rects
// (which the snapshot filter would drop) and lacks scrollIntoView, so both are
// stubbed to let real elements survive and click/type reach the element.
// -----------------------------------------------------------------------------
describe('injected page JS (jsdom)', () => {
  // A webview that actually executes the injected source against the jsdom DOM.
  const evalWebview = () => makeWebview({ executeJavaScript: vi.fn(async (code: string) => eval(code)) })

  beforeEach(() => {
    document.body.innerHTML = ''
    document.title = 'Fixture'
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
    vi.spyOn(document, 'elementFromPoint').mockImplementation(
      () => document.querySelector('[data-cate-ref]'),
    )
    // jsdom doesn't implement scrollIntoView at all — the injected click/type JS
    // calls it, so provide an inert one.
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
  })

  it('snapshot tags visible elements and emits their node shape', async () => {
    document.body.innerHTML =
      '<button aria-label="Save">Save</button>' +
      '<input type="text" placeholder="Email" />' +
      '<a href="/home">Home</a>'
    h.webviews.set('b1', evalWebview())

    const out = await handleBrowserMethod(WS, M('snapshot'), {})
    expect(out.ok).toBe(true)
    const result = (out as {
      ok: true; result: { snapshotId: string; url: string; title: string; refs: unknown[] }
    }).result
    expect(result.url).toBe(location.href)
    expect(result.title).toBe('Fixture')
    expect(result.snapshotId).toBe('s1')
    expect(result.refs).toEqual([
      { ref: '@s1e1', role: 'button', name: 'Save', value: '' },
      { ref: '@s1e2', role: 'input:text', name: 'Email', value: '' },
      { ref: '@s1e3', role: 'a', name: 'Home', value: undefined },
    ])
    // The refs are written back onto the live DOM as data-cate-ref attributes.
    expect(document.querySelector('button')?.getAttribute('data-cate-ref')).toBe('@s1e1')
    expect(document.querySelector('input')?.getAttribute('data-cate-ref')).toBe('@s1e2')
    expect(document.querySelector('a')?.getAttribute('data-cate-ref')).toBe('@s1e3')
  })

  it('reads all geometry/style before writing any data-cate-ref (no layout thrash)', async () => {
    // Efficiency regression: the read phase (getBoundingClientRect +
    // getComputedStyle) must fully precede the write phase (setAttribute
    // 'data-cate-ref'). Interleaving a write between reads invalidates layout and
    // forces a fresh synchronous reflow on the next element — O(n) thrash across
    // the whole match set. We record the order of layout reads vs ref writes and
    // assert every read lands before the first write.
    document.body.innerHTML =
      '<button>A</button><button>B</button><input type="text" /><a href="/x">L</a>'
    const events: string[] = []
    const origSetAttribute = Element.prototype.setAttribute
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => {
      events.push('read')
      return { width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    })
    // The injected source resolves `getComputedStyle` as a global; the outer
    // beforeEach replaces globalThis.window with a stub, so spy on globalThis.
    vi.spyOn(globalThis, 'getComputedStyle').mockImplementation(
      () => ({ visibility: 'visible', display: 'block' }) as CSSStyleDeclaration,
    )
    vi.spyOn(Element.prototype, 'setAttribute').mockImplementation(function (this: Element, name: string, val: string) {
      if (name === 'data-cate-ref') events.push('write')
      return origSetAttribute.call(this, name, val)
    })
    h.webviews.set('b1', evalWebview())

    const out = await handleBrowserMethod(WS, M('snapshot'), {})
    expect(out.ok).toBe(true)

    const firstWrite = events.indexOf('write')
    const lastRead = events.lastIndexOf('read')
    expect(firstWrite).toBeGreaterThanOrEqual(0) // refs were written
    expect(lastRead).toBeGreaterThanOrEqual(0) // geometry/style were read
    // No layout read may occur after the first ref write.
    expect(lastRead).toBeLessThan(firstWrite)
  })

  it('re-running snapshot clears stale data-cate-ref attributes first', async () => {
    // A pre-tagged element the selector will NOT re-tag: it must lose its ref.
    const stale = document.createElement('div')
    stale.setAttribute('data-cate-ref', '@eStale')
    document.body.appendChild(stale)
    document.body.insertAdjacentHTML('beforeend', '<button>Ok</button>')
    h.webviews.set('b1', evalWebview())

    await handleBrowserMethod(WS, M('snapshot'), {})
    expect(stale.hasAttribute('data-cate-ref')).toBe(false)
    // Element indexes restart, but the generation changes so an old ref can
    // never silently address the new @e1.
    expect(document.querySelector('button')?.getAttribute('data-cate-ref')).toBe('@s1e1')
    await handleBrowserMethod(WS, M('snapshot'), {})
    expect(document.querySelector('button')?.getAttribute('data-cate-ref')).toBe('@s2e1')
    expect(await handleBrowserMethod(WS, M('click'), { ref: '@s1e1' })).toEqual({ ok: false, error: 'stale-ref' })
  })

  it('click sends trusted pointer input to the element addressed by a live ref', async () => {
    document.body.innerHTML = '<button aria-label="Go">Go</button>'
    const wv = evalWebview()
    h.webviews.set('b1', wv)
    await handleBrowserMethod(WS, M('snapshot'), {}) // assigns @s1e1

    const out = await handleBrowserMethod(WS, M('click'), { ref: '@s1e1' })
    expect(out).toEqual({ ok: true, result: { ref: '@s1e1' } })
    expect(wv.sendInputEvent.mock.calls.map((call) => call[0].type)).toEqual(['mouseMove', 'mouseDown', 'mouseUp'])
  })

  it('click count 2 sends the second click needed for a dblclick', async () => {
    document.body.innerHTML = '<button aria-label="Go">Go</button>'
    const wv = evalWebview()
    h.webviews.set('b1', wv)
    await handleBrowserMethod(WS, M('snapshot'), {})

    const out = await handleBrowserMethod(WS, M('click'), { ref: '@s1e1', count: 2 })

    expect(out).toEqual({ ok: true, result: { ref: '@s1e1' } })
    expect(wv.sendInputEvent.mock.calls.map((call) => call[0].type)).toEqual([
      'mouseMove', 'mouseDown', 'mouseUp',
      'mouseMove', 'mouseDown', 'mouseUp',
    ])
  })

  it('click on a well-formed but unknown ref returns stale-ref', async () => {
    document.body.innerHTML = '<button>Go</button>'
    h.webviews.set('b1', evalWebview())
    await handleBrowserMethod(WS, M('snapshot'), {})
    const out = await handleBrowserMethod(WS, M('click'), { ref: '@e99' })
    expect(out).toEqual({ ok: false, error: 'stale-ref' })
  })

  it('click accepts a bare generation-scoped ref', async () => {
    document.body.innerHTML = '<button>Go</button>'
    const wv = evalWebview()
    h.webviews.set('b1', wv)
    await handleBrowserMethod(WS, M('snapshot'), {}) // assigns @s1e1
    const out = await handleBrowserMethod(WS, M('click'), { ref: 's1e1' })
    expect(out).toEqual({ ok: true, result: { ref: '@s1e1' } })
    expect(wv.sendInputEvent).toHaveBeenCalled()
  })

  it('click on a malformed ref reports bad-ref, not stale-ref', async () => {
    // Regression: `click nope` used to come back stale-ref, sending the caller
    // off to re-snapshot when the argument itself was the problem.
    document.body.innerHTML = '<button>Go</button>'
    h.webviews.set('b1', evalWebview())
    await handleBrowserMethod(WS, M('snapshot'), {})
    const out = await handleBrowserMethod(WS, M('click'), { ref: '@nope' })
    expect(out).toEqual({ ok: false, error: 'bad-ref: expected a snapshot ref like @s12e7' })
  })

  it('snapshot surfaces input types, label names, select names, and collapsed whitespace', async () => {
    document.body.innerHTML =
      '<label for="q">Search  the\n  web</label><input id="q" type="search" />' +
      '<input type="submit" />' +
      '<select><option>Alpha option text</option><option>Beta option text</option></select>'
    h.webviews.set('b1', evalWebview())

    const out = await handleBrowserMethod(WS, M('snapshot'), {})
    expect(out.ok).toBe(true)
    const refs = (out as { ok: true; result: { refs: Array<{ ref: string; role: string; name: string }> } }).result.refs
    // The search field and its submit button are distinguishable by type, the
    // field is named from its associated <label> (whitespace collapsed), and
    // the <select> does NOT dump every option's text as its name.
    expect(refs).toEqual([
      expect.objectContaining({ ref: '@s1e1', role: 'input:search', name: 'Search the web' }),
      expect.objectContaining({ ref: '@s1e2', role: 'input:submit', name: '' }),
      expect.objectContaining({ ref: '@s1e3', role: 'select', name: '' }),
    ])
  })

  it('snapshot masks passwords and reports useful control state', async () => {
    document.body.innerHTML =
      '<input type="password" aria-label="Password" value="top-secret" />' +
      '<input type="checkbox" aria-label="Remember" checked />' +
      '<button aria-label="Pay" disabled>Pay</button>'
    h.webviews.set('b1', evalWebview())

    const out = await handleBrowserMethod(WS, M('snapshot'), {})
    const refs = (out as { ok: true; result: { refs: Array<Record<string, unknown>> } }).result.refs
    expect(refs[0]).toMatchObject({ role: 'input:password', value: '••••••••' })
    expect(refs[1]).toMatchObject({ role: 'input:checkbox', checked: true })
    expect(refs[2]).toMatchObject({ role: 'button', disabled: true })
    expect(JSON.stringify(out)).not.toContain('top-secret')
  })

  it('type focuses a live ref and inserts text through the trusted guest target', async () => {
    document.body.innerHTML = '<input type="text" />'
    const wv = evalWebview()
    h.webviews.set('b1', wv)
    await handleBrowserMethod(WS, M('snapshot'), {}) // assigns @s1e1

    // Quotes + backslash: JSON-embedded (not interpolated), so must survive verbatim.
    const text = 'a "b" \\c/ \'d\''
    const out = await handleBrowserMethod(WS, M('type'), { ref: '@s1e1', text })
    expect(out).toEqual({ ok: true, result: { ref: '@s1e1' } })
    expect(h.browserControl).toHaveBeenCalledWith({
      op: 'input',
      webContentsId: 99,
      input: 'insertText',
      text,
      delay: 0,
    })
    expect(wv.sendInputEvent).not.toHaveBeenCalled()
  })

  it('fill selects existing content and replaces it through the trusted guest target', async () => {
    document.body.innerHTML = '<input type="text" value="old" />'
    const wv = evalWebview()
    h.webviews.set('b1', wv)
    await handleBrowserMethod(WS, M('snapshot'), {})

    const out = await handleBrowserMethod(WS, M('fill'), { ref: '@s1e1', text: 'new' })
    expect(out).toEqual({ ok: true, result: { ref: '@s1e1' } })
    expect((document.activeElement as HTMLInputElement).selectionStart).toBe(0)
    expect((document.activeElement as HTMLInputElement).selectionEnd).toBe(3)
    expect(h.browserControl).toHaveBeenCalledWith({
      op: 'input',
      webContentsId: 99,
      input: 'replaceText',
      text: 'new',
    })
  })

  it('type on a well-formed but unknown ref returns stale-ref', async () => {
    document.body.innerHTML = '<input type="text" />'
    h.webviews.set('b1', evalWebview())
    await handleBrowserMethod(WS, M('snapshot'), {})
    const out = await handleBrowserMethod(WS, M('type'), { ref: '@e99', text: 'x' })
    expect(out).toEqual({ ok: false, error: 'stale-ref' })
  })
})

describe('wait', () => {
  it('resolves immediately when the guest is not loading', async () => {
    h.webviews.set('b1', makeWebview())
    const out = await handleBrowserMethod(WS, M('wait'), {})
    expect(out).toEqual({ ok: true, result: { url: 'https://example.com/', title: 'Example', loading: false } })
  })

  it('polls until loading settles', async () => {
    const wv = makeWebview({ isLoading: vi.fn().mockReturnValueOnce(true).mockReturnValue(false) })
    h.webviews.set('b1', wv)
    const out = await handleBrowserMethod(WS, M('wait'), {})
    expect(out).toMatchObject({ ok: true })
    expect(wv.isLoading.mock.calls.length).toBeGreaterThan(1)
  })

  it('reports still-loading past the deadline', async () => {
    h.webviews.set('b1', makeWebview({ isLoading: vi.fn(() => true) }))
    const out = await handleBrowserMethod(WS, M('wait'), { timeoutMs: 1 })
    expect(out).toEqual({ ok: false, error: 'still-loading' })
  })

  it('waits on text, disappearance, URL globs, and ref visibility', async () => {
    document.body.innerHTML = '<button>Saved</button>'
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
    const wv = makeWebview({
      getURL: vi.fn(() => 'https://app.test/jobs/42/done'),
      executeJavaScript: vi.fn(async (code: string) => eval(code)),
    })
    h.webviews.set('b1', wv)

    expect(await handleBrowserMethod(WS, M('wait'), {
      condition: { kind: 'text', value: 'Saved' },
    })).toMatchObject({ ok: true })
    expect(await handleBrowserMethod(WS, M('wait'), {
      condition: { kind: 'textGone', value: 'Loading' },
    })).toMatchObject({ ok: true })

    // executeJavaScript observes jsdom's URL, while getURL is the webview URL.
    const hrefPattern = `${location.origin}/**`
    expect(await handleBrowserMethod(WS, M('wait'), {
      condition: { kind: 'url', value: hrefPattern },
    })).toMatchObject({ ok: true })

    const snap = await handleBrowserMethod(WS, M('snapshot'), {}) as {
      ok: true; result: { refs: Array<{ ref: string }> }
    }
    expect(await handleBrowserMethod(WS, M('wait'), {
      condition: { kind: 'ref', ref: snap.result.refs[0].ref, state: 'visible' },
    })).toMatchObject({ ok: true })
  })

  it('returns a stable condition timeout and can include the next snapshot', async () => {
    document.body.innerHTML = '<button>Ready</button>'
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
    const wv = makeWebview({ executeJavaScript: vi.fn(async (code: string) => eval(code)) })
    h.webviews.set('b1', wv)

    expect(await handleBrowserMethod(WS, M('wait'), {
      condition: { kind: 'text', value: 'Never' },
      timeoutMs: 1,
    })).toEqual({ ok: false, error: 'wait-timeout:text' })

    const observed = await handleBrowserMethod(WS, M('wait'), {
      condition: { kind: 'text', value: 'Ready' },
      includeSnapshot: true,
    }) as { ok: true; result: { snapshot: { snapshotId: string } } }
    expect(observed.result.snapshot.snapshotId).toBe('s1')
  })
})

describe('press', () => {
  it('dispatches Enter through the guest CDP target', async () => {
    const wv = makeWebview()
    h.webviews.set('b1', wv)
    const out = await handleBrowserMethod(WS, M('press'), { key: 'Enter' })
    expect(out).toEqual({ ok: true })
    expect(h.browserControl).toHaveBeenCalledWith({
      op: 'input',
      input: 'key',
      key: 'Return',
      modifiers: [],
      webContentsId: 99,
    })
    // No ref -> no focus script ran.
    expect(wv.executeJavaScript).not.toHaveBeenCalled()
  })

  it('dispatches non-committing keys without host input events', async () => {
    const wv = makeWebview()
    h.webviews.set('b1', wv)
    await handleBrowserMethod(WS, M('press'), { key: 'PageDown' })
    expect(h.browserControl).toHaveBeenCalledWith(expect.objectContaining({
      op: 'input',
      input: 'key',
      key: 'PageDown',
    }))
    expect(wv.sendInputEvent).not.toHaveBeenCalled()
  })

  it('focuses the ref first and propagates a stale ref', async () => {
    const wv = makeWebview({ executeJavaScript: vi.fn(async () => ({ error: 'stale-ref' })) })
    h.webviews.set('b1', wv)
    const out = await handleBrowserMethod(WS, M('press'), { key: 'Enter', ref: '@e9' })
    expect(out).toEqual({ ok: false, error: 'stale-ref' })
    expect(wv.sendInputEvent).not.toHaveBeenCalled()
  })

  it('rejects a key outside the allowlist', async () => {
    h.webviews.set('b1', makeWebview())
    const out = await handleBrowserMethod(WS, M('press'), { key: 'F13' })
    expect(out).toEqual({ ok: false, error: 'unsupported-key' })
  })

  it('accepts friendly aliases case-insensitively', async () => {
    const wv = makeWebview()
    h.webviews.set('b1', wv)
    await handleBrowserMethod(WS, M('press'), { key: 'arrowdown' })
    expect(h.browserControl).toHaveBeenCalledWith(expect.objectContaining({ key: 'Down' }))
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

// =============================================================================
// The agent-facing surface added in API v5. These cover the parts whose failure
// mode is SILENT — a locator that acts on the wrong element, a check that
// toggles instead of setting, a cursor event that never reaches the overlay.
// =============================================================================

describe('locators', () => {
  const evalWebview = () => makeWebview({ executeJavaScript: vi.fn(async (code: string) => eval(code)) })

  beforeEach(() => {
    document.body.innerHTML = ''
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
    vi.spyOn(document, 'elementFromPoint').mockImplementation(() => document.querySelector('[data-cate-ref]'))
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
  })

  it('finds by role and tags the matches with refs', async () => {
    document.body.innerHTML = '<button>Save</button><button>Cancel</button>'
    h.webviews.set('b1', evalWebview())
    const out = await handleBrowserMethod(WS, M('find'), { by: 'role', value: 'button' })
    const refs = (out as { ok: true; result: { refs: Array<{ ref: string; name: string }> } }).result.refs
    expect(refs.map((r) => r.name)).toEqual(['Save', 'Cancel'])
    expect(document.querySelectorAll('[data-cate-ref]')).toHaveLength(2)
  })

  it('inspects text, attributes, and state through one locator', async () => {
    document.body.innerHTML = '<button aria-label="Save" disabled>Save now</button>'
    h.webviews.set('b1', evalWebview())

    const out = await handleBrowserMethod(WS, M('inspect'), { by: 'role', value: 'button' })

    expect(out).toEqual({
      ok: true,
      result: expect.objectContaining({
        ref: '@s1e1',
        text: 'Save now',
        tag: 'button',
        attributes: expect.objectContaining({ 'aria-label': 'Save' }),
        enabled: false,
      }),
    })
  })

  it('finds by text on the tightest wrapping element, not every ancestor', async () => {
    document.body.innerHTML = '<div><section><span>Sign in</span></section></div>'
    h.webviews.set('b1', evalWebview())
    const out = await handleBrowserMethod(WS, M('find'), { by: 'text', value: 'Sign in' })
    const refs = (out as { ok: true; result: { refs: Array<{ role: string }> } }).result.refs
    expect(refs).toHaveLength(1)
    expect(refs[0].role).toBe('span')
  })

  it('refuses to act on an ambiguous locator unless nth picks one', async () => {
    document.body.innerHTML = '<button>Go</button><button>Go</button>'
    h.webviews.set('b1', evalWebview())
    const ambiguous = await handleBrowserMethod(WS, M('click'), { by: 'text', value: 'Go' })
    expect(ambiguous).toEqual({ ok: false, error: 'ambiguous:2' })

    // The hit test must resolve to the element nth actually selected, so point
    // the fixture's elementFromPoint at the second button.
    vi.spyOn(document, 'elementFromPoint').mockImplementation(() => document.querySelectorAll('button')[1])
    const picked = await handleBrowserMethod(WS, M('click'), { by: 'text', value: 'Go', nth: 1 })
    expect((picked as { ok: boolean }).ok).toBe(true)
  })

  it('reports no-match rather than acting on nothing', async () => {
    document.body.innerHTML = '<button>Go</button>'
    h.webviews.set('b1', evalWebview())
    expect(await handleBrowserMethod(WS, M('click'), { by: 'text', value: 'Nope' }))
      .toEqual({ ok: false, error: 'no-match' })
  })

  it('keeps snapshot refs valid after a find (same generation)', async () => {
    document.body.innerHTML = '<button>One</button><a href="/x">Two</a>'
    h.webviews.set('b1', evalWebview())
    await handleBrowserMethod(WS, M('snapshot'), {})
    const before = document.querySelector('button')!.getAttribute('data-cate-ref')
    await handleBrowserMethod(WS, M('find'), { by: 'css', value: 'a' })
    expect(document.querySelector('button')!.getAttribute('data-cate-ref')).toBe(before)
  })
})

describe('tabs', () => {
  function controllerStub() {
    return {
      navigate: vi.fn(),
      listTabs: vi.fn(() => [{ id: 'tab-1', url: 'https://a/', title: 'A', active: true }]),
      newTab: vi.fn(() => 'tab-2'),
      selectTab: vi.fn((id: string) => id === 'tab-1'),
      closeTab: vi.fn((id: string) => id === 'tab-1'),
    }
  }

  it('lists, opens, selects and closes tabs through the panel controller', async () => {
    const controller = controllerStub()
    h.controllers.set('b1', controller as never)
    expect(await handleBrowserMethod(WS, M('tabs'), {})).toEqual({
      ok: true,
      result: { panelId: 'b1', tabs: [{ id: 'tab-1', url: 'https://a/', title: 'A', active: true }] },
    })
    expect(await handleBrowserMethod(WS, M('tabNew'), { url: 'https://b/' }))
      .toEqual({ ok: true, result: { panelId: 'b1', tabId: 'tab-2' } })
    expect(controller.newTab).toHaveBeenCalledWith('https://b/')
    expect(await handleBrowserMethod(WS, M('tabSelect'), { tabId: 'tab-1' })).toEqual({ ok: true, result: { tabId: 'tab-1' } })
    expect(await handleBrowserMethod(WS, M('tabClose'), { tabId: 'ghost' })).toEqual({ ok: false, error: 'no-such-tab' })
  })

  it('accepts the unique short tab ids printed by the human CLI', async () => {
    const controller = {
      ...controllerStub(),
      listTabs: vi.fn(() => [
        { id: 'tab-11111111-aaaa', url: 'https://a/', title: 'A', active: true },
        { id: 'tab-22222222-bbbb', url: 'https://b/', title: 'B', active: false },
      ]),
      selectTab: vi.fn((id: string) => id === 'tab-11111111-aaaa'),
      closeTab: vi.fn((id: string) => id === 'tab-22222222-bbbb'),
    }
    h.controllers.set('b1', controller as never)

    expect(await handleBrowserMethod(WS, M('tabSelect'), { tabId: 'tab-1111' }))
      .toEqual({ ok: true, result: { tabId: 'tab-11111111-aaaa' } })
    expect(await handleBrowserMethod(WS, M('tabClose'), { tabId: 'tab-2222' }))
      .toEqual({ ok: true, result: { tabId: 'tab-22222222-bbbb' } })
    expect(controller.selectTab).toHaveBeenCalledWith('tab-11111111-aaaa')
    expect(controller.closeTab).toHaveBeenCalledWith('tab-22222222-bbbb')
  })

  it('rejects an ambiguous short tab id', async () => {
    const controller = {
      ...controllerStub(),
      listTabs: vi.fn(() => [
        { id: 'tab-11111111-aaaa', url: 'https://a/', title: 'A', active: true },
        { id: 'tab-11111111-bbbb', url: 'https://b/', title: 'B', active: false },
      ]),
    }
    h.controllers.set('b1', controller as never)
    expect(await handleBrowserMethod(WS, M('tabSelect'), { tabId: 'tab-1111' }))
      .toEqual({ ok: false, error: 'ambiguous-tab' })
  })

  it('works on a start-page panel that has no webview at all', async () => {
    // Tabs are panel state, not guest state — requiring a live webview here
    // would make a fresh browser panel untabbable until something loads.
    h.controllers.set('b1', controllerStub() as never)
    expect(h.webviews.get('b1')).toBeUndefined()
    expect((await handleBrowserMethod(WS, M('tabs'), {}) as { ok: boolean }).ok).toBe(true)
  })

  it('reports panel-not-mounted when no panel is rendering', async () => {
    expect(await handleBrowserMethod(WS, M('tabs'), {})).toEqual({ ok: false, error: 'panel-not-mounted' })
  })
})

describe('check / uncheck idempotence', () => {
  it('does not click when the box is already in the wanted state', async () => {
    const exec = vi.fn(async (code: string) =>
      code.includes('checked: checked') ? { checked: true } : { ok: true, x: 5, y: 5, rect: '0:0:10:10' })
    const wv = makeWebview({ executeJavaScript: exec })
    h.webviews.set('b1', wv)
    const out = await handleBrowserMethod(WS, M('check'), { ref: '@s1e1' })
    expect(out).toEqual({ ok: true, result: { ref: '@s1e1', checked: true, changed: false } })
    expect(wv.sendInputEvent).not.toHaveBeenCalled()
  })

  it('clicks once when the state must change', async () => {
    const exec = vi.fn(async (code: string) =>
      code.includes('checked: checked') ? { checked: false } : { ok: true, x: 5, y: 5, rect: '0:0:10:10' })
    const wv = makeWebview({ executeJavaScript: exec })
    h.webviews.set('b1', wv)
    const out = await handleBrowserMethod(WS, M('check'), { ref: '@s1e1' })
    expect(out).toEqual({ ok: true, result: { ref: '@s1e1', checked: true, changed: true } })
    expect(wv.sendInputEvent.mock.calls.map((c) => c[0].type)).toEqual(['mouseMove', 'mouseDown', 'mouseUp'])
  })
})

describe('keyboard combos', () => {
  it('dispatches a modified shortcut through the guest CDP session', async () => {
    const wv = makeWebview()
    h.webviews.set('b1', wv)
    await handleBrowserMethod(WS, M('press'), { key: 'cmd+a' })
    expect(h.browserControl).toHaveBeenCalledWith({
      op: 'input',
      webContentsId: 99,
      input: 'key',
      key: 'a',
      modifiers: ['Meta'],
    })
    expect(wv.sendInputEvent).not.toHaveBeenCalled()
  })

  it('dispatches a plain letter through the guest CDP session', async () => {
    const wv = makeWebview()
    h.webviews.set('b1', wv)
    await handleBrowserMethod(WS, M('press'), { key: 'a' })
    expect(h.browserControl).toHaveBeenCalledWith({
      op: 'input',
      webContentsId: 99,
      input: 'key',
      key: 'a',
      modifiers: [],
    })
    expect(wv.sendInputEvent).not.toHaveBeenCalled()
  })
})

describe('mouse + scroll', () => {
  it('drives raw coordinates with a full press/move/release drag', async () => {
    const wv = makeWebview()
    h.webviews.set('b1', wv)
    await handleBrowserMethod(WS, M('mouse'), { action: 'drag', x: 10, y: 10, toX: 50, toY: 60 })
    const types = wv.sendInputEvent.mock.calls.map((c) => c[0].type)
    expect(types[0]).toBe('mouseMove')
    expect(types[1]).toBe('mouseDown')
    // Intermediate moves are what make HTML5/JS drag implementations engage.
    expect(types.filter((t) => t === 'mouseMove').length).toBeGreaterThan(2)
    expect(types[types.length - 1]).toBe('mouseUp')
  })

  it('requires coordinates', async () => {
    h.webviews.set('b1', makeWebview())
    expect(await handleBrowserMethod(WS, M('mouse'), { action: 'click' }))
      .toEqual({ ok: false, error: 'x-and-y-required' })
  })

  it('uses wheel input for a delta scroll', async () => {
    const wv = makeWebview()
    h.webviews.set('b1', wv)
    await handleBrowserMethod(WS, M('scroll'), { dx: 0, dy: 400 })
    const event = wv.sendInputEvent.mock.calls[0][0] as Record<string, unknown>
    expect(event.type).toBe('mouseWheel')
    expect(event.deltaY).toBe(400)
  })
})

describe('screenshots', () => {
  it('routes a full-page capture through the main-process control channel', async () => {
    h.webviews.set('b1', makeWebview())
    const out = await handleBrowserMethod(WS, M('screenshot'), { mode: 'fullPage' })
    expect(out).toEqual({ ok: true, result: { path: '/tmp/full.png' } })
    expect(h.browserControl).toHaveBeenCalledWith({ op: 'screenshot', mode: 'fullPage', webContentsId: 99 })
  })

  it('crops to the element box for an element capture', async () => {
    const exec = vi.fn(async () => ({ ok: true, x: 5, y: 5, rect: '0:0:10:10', box: [1, 2, 30, 40] }))
    h.webviews.set('b1', makeWebview({ executeJavaScript: exec }))
    const out = await handleBrowserMethod(WS, M('screenshot'), { mode: 'element', ref: '@s1e1' })
    expect((out as { ok: boolean }).ok).toBe(true)
    expect(h.browserControl).toHaveBeenCalledWith({
      op: 'screenshot', mode: 'rect', rect: { x: 1, y: 2, width: 30, height: 40 }, webContentsId: 99,
    })
  })

  it('surfaces a control-channel error instead of a bare failure', async () => {
    h.browserControl.mockResolvedValueOnce({ error: 'no-guest' })
    h.webviews.set('b1', makeWebview())
    expect(await handleBrowserMethod(WS, M('screenshot'), { mode: 'fullPage' }))
      .toEqual({ ok: false, error: 'no-guest' })
  })
})

describe('evaluate', () => {
  it('returns the value and reports a thrown error as data', async () => {
    const wv = makeWebview({ executeJavaScript: vi.fn(async (code: string) => eval(code)) })
    h.webviews.set('b1', wv)
    expect(await handleBrowserMethod(WS, M('evaluate'), { expression: '1 + 1' }))
      .toEqual({ ok: true, result: { value: 2 } })
    const failed = await handleBrowserMethod(WS, M('evaluate'), { expression: 'nope.boom()' })
    expect((failed as { ok: false; error: string }).error).toMatch(/^eval-failed:/)
  })

  it('requires an expression', async () => {
    h.webviews.set('b1', makeWebview())
    expect(await handleBrowserMethod(WS, M('evaluate'), {})).toEqual({ ok: false, error: 'expression-required' })
  })
})
