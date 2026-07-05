// =============================================================================
// webSecurity.installWebContentsSecurity — the will-attach-webview hardening.
// Focus: the preload pinning for extension-proxy guests. An extension guest must
// run the CANONICAL cateHost preload, never whatever preload path the renderer
// supplied (a compromised renderer could point it at an arbitrary file). A plain
// (non-proxy) guest keeps having its preload stripped entirely.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

const PROXY_ORIGIN = 'http://127.0.0.1:5555'
const CANONICAL_PRELOAD = '/app/dist/preload/cateHost.js'

vi.mock('./extensions/proxyServer', () => ({
  getProxyOrigin: () => PROXY_ORIGIN,
  getCateHostPreloadPath: () => CANONICAL_PRELOAD,
}))
vi.mock('./featureFlags', () => ({ disableWebviewHardening: () => false }))
vi.mock('./logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

// Capture the app.on('web-contents-created') callback so we can drive it.
const { createdHandlers } = vi.hoisted(() => ({ createdHandlers: [] as Array<(e: unknown, c: unknown) => void> }))
vi.mock('electron', () => ({
  app: { on: (ev: string, cb: (e: unknown, c: unknown) => void) => { if (ev === 'web-contents-created') createdHandlers.push(cb) } },
  session: { fromPartition: () => makeSession() },
  shell: { openExternal: vi.fn() },
}))

function makeSession(): Record<string, unknown> {
  return {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn() },
  }
}

import { installWebContentsSecurity } from './webSecurity'

/** Build a fake webview WebContents, run the created-handlers over it, and
 *  return its captured will-attach-webview handler. */
function attachHandlerForWebview(): (event: unknown, wp: Record<string, unknown>, params: Record<string, unknown>) => void {
  const listeners: Record<string, (...a: unknown[]) => void> = {}
  const contents = {
    getType: () => 'webview',
    on: (ev: string, cb: (...a: unknown[]) => void) => { listeners[ev] = cb },
    setWindowOpenHandler: vi.fn(),
    session: makeSession(),
  }
  for (const cb of createdHandlers) cb({}, contents)
  return listeners['will-attach-webview'] as never
}

beforeEach(() => {
  createdHandlers.length = 0
  installWebContentsSecurity()
})

describe('will-attach-webview — extension-proxy preload pinning', () => {
  it('overwrites an attacker-supplied preload with the canonical cateHost path for a proxy-origin guest', () => {
    const handler = attachHandlerForWebview()
    const webPreferences: Record<string, unknown> = { preload: '/tmp/evil.js', preloadURL: 'file:///tmp/evil.js' }
    const params: Record<string, unknown> = { src: `${PROXY_ORIGIN}/ext/abc123/index.html` }
    handler({ preventDefault: vi.fn() }, webPreferences, params)
    expect(webPreferences.preload).toBe(CANONICAL_PRELOAD)
    expect(webPreferences.preloadURL).toBeUndefined()
    // Standard hardening still applied.
    expect(webPreferences.nodeIntegration).toBe(false)
    expect(webPreferences.contextIsolation).toBe(true)
    expect(webPreferences.sandbox).toBe(true)
  })

  it('strips the preload entirely for a plain (non-proxy) guest', () => {
    const handler = attachHandlerForWebview()
    const webPreferences: Record<string, unknown> = { preload: '/tmp/evil.js', preloadURL: 'file:///tmp/evil.js' }
    const params: Record<string, unknown> = { src: 'https://example.com/page.html' }
    handler({ preventDefault: vi.fn() }, webPreferences, params)
    expect(webPreferences.preload).toBeUndefined()
    expect(webPreferences.preloadURL).toBeUndefined()
  })
})
