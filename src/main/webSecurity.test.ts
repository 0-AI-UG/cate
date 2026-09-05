import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./featureFlags', () => ({ disableWebviewHardening: () => false }))
vi.mock('./logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

// Capture the app.on('web-contents-created') callback so we can drive it.
const { createdHandlers } = vi.hoisted(() => ({ createdHandlers: [] as Array<(e: unknown, c: unknown) => void> }))
vi.mock('electron', () => ({
  app: {
    getName: () => 'Cate',
    getLocale: () => 'en-US',
    on: (ev: string, cb: (e: unknown, c: unknown) => void) => {
      if (ev === 'web-contents-created') createdHandlers.push(cb)
    },
  },
  session: { fromPartition: () => makeSession() },
}))

function makeSession(): Record<string, unknown> {
  return {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    getUserAgent: vi.fn(() => 'Mozilla/5.0 Chrome/142.0.0.0 Electron/41.0.0 Cate/1.0.0 Safari/537.36'),
    setUserAgent: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn(), onBeforeSendHeaders: vi.fn() },
  }
}

import { installWebContentsSecurity } from './webSecurity'

/** Build a fake webview WebContents, run the created-handlers over it, and
 *  return its captured will-attach-webview handler. */
function webviewHarness() {
  const listeners: Record<string, (...a: unknown[]) => void> = {}
  const contents = {
    id: 42,
    getType: () => 'webview',
    on: (ev: string, cb: (...a: unknown[]) => void) => { listeners[ev] = cb },
    setWindowOpenHandler: vi.fn(),
    hostWebContents: { send: vi.fn() },
    session: makeSession(),
  }
  for (const cb of createdHandlers) cb({}, contents)
  return { contents, listeners }
}

function attachHandlerForWebview(): (event: unknown, wp: Record<string, unknown>, params: Record<string, unknown>) => void {
  return webviewHarness().listeners['will-attach-webview'] as never
}

beforeEach(() => {
  createdHandlers.length = 0
  installWebContentsSecurity()
})

describe('will-attach-webview — extension-proxy preload pinning', () => {

  it('pins the minimal browser preload for a plain guest', () => {
    const handler = attachHandlerForWebview()
    const webPreferences: Record<string, unknown> = { preload: '/tmp/evil.js', preloadURL: 'file:///tmp/evil.js' }
    const params: Record<string, unknown> = { src: 'https://example.com/page.html' }
    handler({ preventDefault: vi.fn() }, webPreferences, params)
    expect(webPreferences.preload).toMatch(/[/\\]preload[/\\]browserGuest\.js$/)
    expect(webPreferences.preloadURL).toBeUndefined()
  })

  it('allows a sandboxed data URL to attach and navigate in a browser guest', () => {
    const { listeners } = webviewHarness()
    const attachEvent = { preventDefault: vi.fn() }
    listeners['will-attach-webview'](
      attachEvent,
      {},
      { src: 'data:text/html,%3Ch1%3EFixture%3C%2Fh1%3E' },
    )
    expect(attachEvent.preventDefault).not.toHaveBeenCalled()

    const navigateEvent = { preventDefault: vi.fn() }
    listeners['will-navigate'](
      navigateEvent,
      'data:text/html,%3Ch1%3EFixture%3C%2Fh1%3E',
    )
    expect(navigateEvent.preventDefault).not.toHaveBeenCalled()
  })
})

describe('browser popup policy', () => {
  it('routes HTTPS popups into the opener panel tab layer and blocks unsafe schemes', () => {
    const { contents, listeners } = webviewHarness()
    listeners['will-attach-webview'](
      { preventDefault: vi.fn() },
      {},
      { src: 'https://example.com' },
    )
    const handler = contents.setWindowOpenHandler.mock.calls[0][0] as (details: { url: string }) => {
      action: 'allow' | 'deny'
      outlivesOpener?: boolean
    }

    expect(handler({ url: 'https://accounts.google.com/o/oauth2/auth' })).toEqual({ action: 'deny' })
    expect(contents.hostWebContents.send).toHaveBeenCalledWith('browser:openTabRequest', {
      openerWebContentsId: 42,
      url: 'https://accounts.google.com/o/oauth2/auth',
    })
    expect(handler({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' })
  })
})

describe('app-window navigation', () => {
  it('does not permit remote browser content in top-level app windows', () => {
    const listeners: Record<string, (...args: unknown[]) => void> = {}
    const contents = {
      getType: () => 'window',
      on: (event: string, callback: (...args: unknown[]) => void) => { listeners[event] = callback },
      setWindowOpenHandler: vi.fn(),
      session: makeSession(),
    }
    for (const callback of createdHandlers) callback({}, contents)

    const httpsNavigation = { preventDefault: vi.fn() }
    listeners['will-navigate'](httpsNavigation, 'https://de.wikipedia.org/')
    expect(httpsNavigation.preventDefault).toHaveBeenCalledOnce()

    const unsafeNavigation = { preventDefault: vi.fn() }
    listeners['will-navigate'](unsafeNavigation, 'javascript:alert(1)')
    expect(unsafeNavigation.preventDefault).toHaveBeenCalledOnce()
  })
})
