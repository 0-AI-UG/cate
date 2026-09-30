import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const { EventEmitter: Emitter } = require('node:events') as typeof import('node:events')
  const app = Object.assign(new Emitter(), { getName: () => 'Cate', getLocale: () => 'en' })
  const guestSession = {
    getUserAgent: () => 'Mozilla/5.0 Chrome/140.0.0.0 Electron/41.0.0 Cate/2.0.0',
    setUserAgent: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    webRequest: { onBeforeSendHeaders: vi.fn(), onBeforeRequest: vi.fn() },
  }
  return { app, guestSession, fromPartition: vi.fn(() => guestSession) }
})
vi.mock('electron', () => ({ app: h.app, session: { fromPartition: h.fromPartition } }))
vi.mock('@services/browser/desktop', () => ({ sendBrowserShortcut: vi.fn(), sendOpenTabRequest: vi.fn() }))

import { browserActionForInput, forwardedActionForInput, installWebSecurity, isAllowedGuestUrl, isTrustedAppUrl } from './webSecurity'

function contents(type: string) {
  return Object.assign(new EventEmitter(), { getType: () => type, setWindowOpenHandler: vi.fn(), session: h.guestSession, hostWebContents: { send: vi.fn() } })
}

describe('web security', () => {
  beforeEach(() => {
    h.app.removeAllListeners()
    installWebSecurity({
      guestPreload: '/app/preload/shellGuest.js',
      hardeningDisabled: () => false,
      customShortcuts: () => ({}),
      isPreparedPartition: (partition) => partition === 'persist:ws-abcdefghijklmnop',
      platform: 'darwin',
    })
  })

  const attach = (partition: string | undefined, src = 'https://example.com', preload = '/evil.js') => {
    const host = contents('window')
    h.app.emit('web-contents-created', {}, host)
    const event = { preventDefault: vi.fn() }
    const webPreferences: Record<string, unknown> = { partition, preload, nodeIntegration: true, sandbox: false }
    const params: Record<string, unknown> = { src }
    host.emit('will-attach-webview', event, webPreferences, params)
    return { event, webPreferences, params }
  }

  it('pins the guest preload and sandbox on a prepared workspace partition', () => {
    const { event, webPreferences, params } = attach('persist:ws-abcdefghijklmnop')
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(webPreferences).toMatchObject({ preload: '/app/preload/shellGuest.js', nodeIntegration: false, sandbox: true, contextIsolation: true })
    expect(params.allowpopups).toBe('true')
    expect(h.guestSession.setUserAgent).toHaveBeenCalledWith('Mozilla/5.0 Chrome/140.0.0.0', 'en')
  })

  it('refuses a guest outside a prepared workspace partition (loopback must mean the runtime)', () => {
    expect(attach(undefined).event.preventDefault).toHaveBeenCalled()
    expect(attach('persist:other').event.preventDefault).toHaveBeenCalled()
    expect(attach('persist:ws-abcdefghijklmnop', 'javascript:alert(1)').event.preventDefault).toHaveBeenCalled()
  })

  it('keeps app windows on the app', () => {
    expect(isTrustedAppUrl('file:///app/index.html')).toBe(true)
    expect(isTrustedAppUrl('http://localhost:5173/x', 'http://localhost:5173')).toBe(true)
    expect(isTrustedAppUrl('https://evil.test/', 'http://localhost:5173')).toBe(false)
    const host = contents('window')
    h.app.emit('web-contents-created', {}, host)
    const event = { preventDefault: vi.fn() }
    host.emit('will-navigate', event, 'https://evil.test/')
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('allows only web, file and data pages in guests', () => {
    for (const url of ['about:blank', 'https://a.test', 'http://localhost:3000', 'file:///x.html', 'data:text/html,hi']) expect(isAllowedGuestUrl(url)).toBe(true)
    for (const url of ['javascript:alert(1)', 'chrome://settings', 'not a url']) expect(isAllowedGuestUrl(url)).toBe(false)
  })

  it('maps guest keys to browser actions and forwarded canvas shortcuts', () => {
    const key = { type: 'keyDown' as const, meta: true, control: false, shift: false, alt: false }
    expect(browserActionForInput({ ...key, code: 'KeyR' }, 'darwin')).toBe('reload')
    expect(browserActionForInput({ ...key, shift: true, code: 'KeyR' }, 'darwin')).toBe('reloadHard')
    expect(browserActionForInput({ ...key, code: 'KeyR' }, 'win32')).toBeNull()
    expect(forwardedActionForInput({ ...key, key: 'k' }, {}, 'darwin')).toBe('commandPalette')
    expect(forwardedActionForInput({ ...key, key: 't' }, {}, 'darwin')).toBeNull()
  })
})
