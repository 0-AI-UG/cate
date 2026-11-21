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
vi.mock('@services/browser/desktop', () => ({ isAgentKeyInput: () => false, sendBrowserShortcut: vi.fn(), sendOpenTabRequest: vi.fn() }))

import { browserActionForInput, forwardedActionForInput, installWebSecurity, isTrustedAppUrl } from './webSecurity'

function contents(type: string) {
  return Object.assign(new EventEmitter(), { getType: () => type, setWindowOpenHandler: vi.fn(), session: h.guestSession, hostWebContents: { send: vi.fn() } })
}

describe('web security', () => {
  beforeEach(() => {
    h.app.removeAllListeners()
    installWebSecurity({ rendererUrl: 'http://localhost:5173' })
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

  it('refuses embedded page attachment in a UI window', () => {
    expect(attach('persist:ws-abcdefghijklmnop').event.preventDefault).toHaveBeenCalled()
    expect(attach(undefined).event.preventDefault).toHaveBeenCalled()
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

  it('maps guest keys to browser actions and forwarded canvas shortcuts', () => {
    const key = { type: 'keyDown' as const, meta: true, control: false, shift: false, alt: false }
    expect(browserActionForInput({ ...key, code: 'KeyR' }, 'darwin')).toBe('reload')
    expect(browserActionForInput({ ...key, shift: true, code: 'KeyR' }, 'darwin')).toBe('reloadHard')
    expect(browserActionForInput({ ...key, code: 'KeyR' }, 'win32')).toBeNull()
    const guestKeys = [{ action: 'commandPalette', shortcut: { key: 'k', command: true, shift: false, option: false, control: false } }]
    expect(forwardedActionForInput({ ...key, key: 'k' }, guestKeys, 'darwin')).toBe('commandPalette')
    expect(forwardedActionForInput({ ...key, key: 't' }, guestKeys, 'darwin')).toBeNull()
  })
})
