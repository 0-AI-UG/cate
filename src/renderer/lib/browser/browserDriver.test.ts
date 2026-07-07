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
    expect(out).toEqual({ ok: true, result: { panelId: 'created-browser-id', url: 'https://new/' } })
  })

  it('loads the URL into the existing browser and mirrors it to the store', async () => {
    const wv = makeWebview()
    h.webviews.set('b1', wv)
    const out = await handleBrowserMethod(WS, M('open'), { url: 'https://go/' })
    expect(wv.loadURL).toHaveBeenCalledWith('https://go/')
    expect(h.updatePanelUrl).toHaveBeenCalledWith(WS, 'b1', 'https://go/')
    expect(out).toEqual({ ok: true, result: { panelId: 'b1', url: 'https://go/' } })
  })

  it('mirrors the URL to the store when the webview is not attached yet (succeeds)', async () => {
    const out = await handleBrowserMethod(WS, M('open'), { url: 'https://later/' })
    expect(h.updatePanelUrl).toHaveBeenCalledWith(WS, 'b1', 'https://later/')
    expect(out).toEqual({ ok: true, result: { panelId: 'b1', url: 'https://later/' } })
  })

  it('requires a url', async () => {
    const out = await handleBrowserMethod(WS, M('open'), {})
    expect(out).toEqual({ ok: false, error: 'url-required' })
  })

  it('returns the resolved url alongside panelId for every branch (the { panelId, url } contract)', async () => {
    // Regression: open used to return { panelId } only, so `cate browser open`
    // printed 'ok' instead of the URL. Every branch must echo the loaded URL.

    // Branch 1: existing browser with a live webview.
    h.webviews.set('b1', makeWebview())
    const loaded = await handleBrowserMethod(WS, M('open'), { url: 'https://go/' })
    expect(loaded).toEqual({ ok: true, result: { panelId: 'b1', url: 'https://go/' } })

    // Branch 2: existing browser panel whose webview is not attached yet.
    h.webviews = new Map()
    const pending = await handleBrowserMethod(WS, M('open'), { url: 'https://later/' })
    expect(pending).toEqual({ ok: true, result: { panelId: 'b1', url: 'https://later/' } })

    // Branch 3: no browser panel — the driver creates one.
    h.workspaces[0].panels = { term: { id: 'term', type: 'terminal', title: 'Term' } }
    const created = await handleBrowserMethod(WS, M('open'), { url: 'https://new/' })
    expect(created).toEqual({ ok: true, result: { panelId: 'created-browser-id', url: 'https://new/' } })
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
      result: [
        { panelId: 'b1', title: 'Docs', url: 'https://docs.example/', focused: false },
        { panelId: 'b2', title: 'New Tab', url: '', focused: true },
      ],
    })
  })

  it('list returns a BARE array (the declared list(): Promise<CateBrowserTab[]> contract)', async () => {
    // Regression: the driver used to wrap the array as { browsers: [...] }, which
    // broke every consumer (preload/CLI) that expects a bare CateBrowserTab[].
    const out = await handleBrowserMethod(WS, M('list'), {})
    expect(out.ok).toBe(true)
    const result = (out as { ok: true; result: unknown }).result
    expect(Array.isArray(result)).toBe(true)
    const tabs = result as Array<{ panelId: string; url: string; title: string }>
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ panelId: 'b1', url: 'https://docs.example/', title: 'Docs' })
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
    // Opts out of the base64 encode: the CLI path only uses the file path.
    expect(h.screenshot).toHaveBeenCalledWith(99, { wantDataUrl: false })
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

describe('webview failure + error paths', () => {
  it('back invokes goBack and succeeds when it can go back', async () => {
    const wv = makeWebview() // canGoBack() → true by default
    h.webviews.set('b1', wv)
    const out = await handleBrowserMethod(WS, M('back'), {})
    expect(out).toEqual({ ok: true })
    expect(wv.goBack).toHaveBeenCalled()
  })

  it('forward invokes goForward and succeeds when it can go forward', async () => {
    const wv = makeWebview() // canGoForward() → true by default
    h.webviews.set('b1', wv)
    const out = await handleBrowserMethod(WS, M('forward'), {})
    expect(out).toEqual({ ok: true })
    expect(wv.goForward).toHaveBeenCalled()
  })

  it('type requires a ref', async () => {
    h.webviews.set('b1', makeWebview())
    const out = await handleBrowserMethod(WS, M('type'), { text: 'hi' })
    expect(out).toEqual({ ok: false, error: 'ref-required' })
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

  it('maps a throwing getURL to webview-not-ready (current)', async () => {
    h.webviews.set('b1', makeWebview({ getURL: vi.fn(() => { throw new Error('guest gone') }) }))
    const out = await handleBrowserMethod(WS, M('current'), {})
    expect(out).toEqual({ ok: false, error: 'webview-not-ready' })
  })

  it('maps a throwing goBack to webview-not-ready (back)', async () => {
    h.webviews.set('b1', makeWebview({ goBack: vi.fn(() => { throw new Error('guest gone') }) }))
    const out = await handleBrowserMethod(WS, M('back'), {})
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
    const result = (out as { ok: true; result: { url: string; title: string; refs: unknown[] } }).result
    expect(result.url).toBe(location.href)
    expect(result.title).toBe('Fixture')
    expect(result.refs).toEqual([
      { ref: '@e1', role: 'button', name: 'Save', value: '' },
      { ref: '@e2', role: 'input', name: 'Email', value: '' },
      { ref: '@e3', role: 'a', name: 'Home', value: undefined },
    ])
    // The refs are written back onto the live DOM as data-cate-ref attributes.
    expect(document.querySelector('button')?.getAttribute('data-cate-ref')).toBe('@e1')
    expect(document.querySelector('input')?.getAttribute('data-cate-ref')).toBe('@e2')
    expect(document.querySelector('a')?.getAttribute('data-cate-ref')).toBe('@e3')
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
    // The button is re-numbered from @e1 on every run (no drift).
    expect(document.querySelector('button')?.getAttribute('data-cate-ref')).toBe('@e1')
    await handleBrowserMethod(WS, M('snapshot'), {})
    expect(document.querySelector('button')?.getAttribute('data-cate-ref')).toBe('@e1')
  })

  it('click activates the element addressed by a live ref', async () => {
    document.body.innerHTML = '<button aria-label="Go">Go</button>'
    const wv = evalWebview()
    h.webviews.set('b1', wv)
    await handleBrowserMethod(WS, M('snapshot'), {}) // assigns @e1
    const clicked = vi.fn()
    document.querySelector('button')!.addEventListener('click', clicked)

    const out = await handleBrowserMethod(WS, M('click'), { ref: '@e1' })
    expect(out).toEqual({ ok: true })
    expect(clicked).toHaveBeenCalledTimes(1)
  })

  it('click on an unknown ref returns stale-ref', async () => {
    document.body.innerHTML = '<button>Go</button>'
    h.webviews.set('b1', evalWebview())
    await handleBrowserMethod(WS, M('snapshot'), {})
    const out = await handleBrowserMethod(WS, M('click'), { ref: '@nope' })
    expect(out).toEqual({ ok: false, error: 'stale-ref' })
  })

  it('type sets the value and dispatches input on a live ref', async () => {
    document.body.innerHTML = '<input type="text" />'
    const wv = evalWebview()
    h.webviews.set('b1', wv)
    await handleBrowserMethod(WS, M('snapshot'), {}) // assigns @e1
    const input = document.querySelector('input')!
    const onInput = vi.fn()
    input.addEventListener('input', onInput)

    // Quotes + backslash: JSON-embedded (not interpolated), so must survive verbatim.
    const text = 'a "b" \\c/ \'d\''
    const out = await handleBrowserMethod(WS, M('type'), { ref: '@e1', text })
    expect(out).toEqual({ ok: true })
    expect(input.value).toBe(text)
    expect(onInput).toHaveBeenCalledTimes(1)
  })

  it('type on an unknown ref returns stale-ref', async () => {
    document.body.innerHTML = '<input type="text" />'
    h.webviews.set('b1', evalWebview())
    await handleBrowserMethod(WS, M('snapshot'), {})
    const out = await handleBrowserMethod(WS, M('type'), { ref: '@nope', text: 'x' })
    expect(out).toEqual({ ok: false, error: 'stale-ref' })
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
