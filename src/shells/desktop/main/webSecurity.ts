// Web security hardening for every webContents: app windows may only show the
// app, guests (browser and chat panels) get the restricted guest preload, a
// sandbox, a workspace partition routed through its loopback proxy, and no
// popups (a popup becomes a tab of the owning browser panel).

import { app, session as electronSession, type Session, type WebContents } from 'electron'
import { createLogger } from '@kernel/log/contract'
import { shortcutMatches, type ActionId } from '@kernel/interaction/contract'
import type { BrowserShortcutAction } from '@services/browser/contract'
import { sendBrowserShortcut, sendOpenTabRequest } from '@services/browser/desktop'
import { DESKTOP_CHANNELS as C, type MenuModel } from '../contract'

const log = createLogger('security')

interface WebSecurityOptions {
  guestPreload: string
  /** The dev server origin, when running under electron-vite dev. */
  rendererUrl?: string
  hardeningDisabled(): boolean
  /** The keys a web page never gets, from the menu model. */
  guestKeys(): MenuModel['guestKeys']
  /** True once the workspace partition's loopback proxy is in place. */
  isPreparedPartition(partition: string): boolean
  platform?: NodeJS.Platform
}

export function isAllowedGuestUrl(url: string): boolean {
  if (url === 'about:blank') return true
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:' || protocol === 'data:'
  } catch {
    return false
  }
}

export function isTrustedAppUrl(url: string, rendererUrl?: string): boolean {
  if (url.startsWith('file://')) return true
  if (!rendererUrl) return false
  try { return new URL(url).origin === new URL(rendererUrl).origin } catch { return false }
}

/** A guest key that drives the browser panel rather than the page. */
export function browserActionForInput(input: Pick<Electron.Input, 'type' | 'meta' | 'control' | 'shift' | 'code'>, platform: NodeJS.Platform): BrowserShortcutAction | null {
  if (input.type !== 'keyDown') return null
  if (!(platform === 'darwin' ? input.meta : input.control)) return null
  switch (input.code) {
    case 'KeyR': return input.shift ? 'reloadHard' : 'reload'
    case 'KeyL': return input.shift ? null : 'focusUrl'
    case 'BracketLeft': return input.shift ? null : 'back'
    case 'BracketRight': return input.shift ? null : 'forward'
    default: return null
  }
}

/** A key pressed inside a guest that the window runs instead (an action
 *  declared `fromGuests`); it never bubbles to the host otherwise. */
export function forwardedActionForInput(input: Pick<Electron.Input, 'type' | 'key' | 'meta' | 'control' | 'alt' | 'shift'>, guestKeys: MenuModel['guestKeys'], platform: NodeJS.Platform): ActionId | null {
  if (input.type !== 'keyDown') return null
  const event = {
    key: input.key,
    // Stored shortcuts say "command" for the platform's primary modifier.
    metaKey: platform === 'darwin' ? input.meta : input.control,
    ctrlKey: platform === 'darwin' ? input.control : false,
    altKey: input.alt,
    shiftKey: input.shift,
  }
  return guestKeys.find(({ shortcut }) => shortcutMatches(event, shortcut))?.action ?? null
}

const guestSessions = new WeakSet<Session>()

function browserUserAgent(target: Session): string {
  const product = app.getName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return target.getUserAgent().replace(/\sElectron\/\S+/g, '').replace(new RegExp(`\\s${product}/\\S+`, 'g'), '')
}

function configureGuestSession(target: Session, platform: NodeJS.Platform): void {
  if (guestSessions.has(target)) return
  guestSessions.add(target)
  const userAgent = browserUserAgent(target)
  target.setUserAgent(userAgent, app.getLocale())
  const chromeMajor = /\b(?:Chrome|Chromium)\/(\d+)\./.exec(userAgent)?.[1]
  target.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }
    const name = (wanted: string) => Object.keys(headers).find((key) => key.toLowerCase() === wanted) ?? wanted
    headers[name('user-agent')] = userAgent
    if (chromeMajor) {
      headers[name('sec-ch-ua')] = `"Chromium";v="${chromeMajor}", "Google Chrome";v="${chromeMajor}", "Not=A?Brand";v="24"`
      headers[name('sec-ch-ua-mobile')] = '?0'
      headers[name('sec-ch-ua-platform')] = platform === 'darwin' ? '"macOS"' : platform === 'win32' ? '"Windows"' : '"Linux"'
    }
    callback({ requestHeaders: headers })
  })
  const allowed = new Set(['cookies', 'storage-access'])
  target.setPermissionRequestHandler((_contents, permission, callback) => {
    if (!allowed.has(permission)) log.warn('denied guest permission %s', permission)
    callback(allowed.has(permission))
  })
  target.setPermissionCheckHandler((_contents, permission) => allowed.has(permission))
  target.webRequest.onBeforeRequest((details, callback) => {
    if (details.resourceType === 'mainFrame' && !isAllowedGuestUrl(details.url)) {
      log.warn('blocked guest navigation to %s', details.url)
      callback({ cancel: true })
      return
    }
    callback({})
  })
}

function hardenGuest(contents: WebContents, options: WebSecurityOptions, platform: NodeJS.Platform): void {
  contents.on('will-navigate', (event, url) => {
    if (!isAllowedGuestUrl(url)) {
      log.warn('blocked guest navigation to %s', url)
      event.preventDefault()
    }
  })
  contents.setWindowOpenHandler(({ url }) => {
    if (guestSessions.has(contents.session) && isAllowedGuestUrl(url)) sendOpenTabRequest(contents, url)
    else log.warn('blocked popup to %s', url)
    return { action: 'deny' }
  })
  contents.on('before-input-event', (event, input) => {
    const host = contents.hostWebContents
    if (!host) return
    const forwarded = forwardedActionForInput(input, options.guestKeys(), platform)
    if (forwarded) {
      event.preventDefault()
      host.send(C.menuAction, forwarded)
      return
    }
    const action = browserActionForInput(input, platform)
    if (!action) return
    event.preventDefault()
    sendBrowserShortcut(host, action)
  })
}

export function installWebSecurity(options: WebSecurityOptions): void {
  const platform = options.platform ?? process.platform
  app.on('web-contents-created', (_event, contents) => {
    const type = contents.getType()
    if (type === 'webview') hardenGuest(contents, options, platform)
    else contents.setWindowOpenHandler(() => ({ action: 'deny' }))

    if (type === 'window') {
      contents.on('will-navigate', (event, url) => {
        if (!isTrustedAppUrl(url, options.rendererUrl)) {
          log.warn('blocked app window navigation to %s', url)
          event.preventDefault()
        }
      })
    }

    contents.on('will-attach-webview', (event, webPreferences, params) => {
      if (options.hardeningDisabled()) return
      const src = typeof params.src === 'string' ? params.src : 'about:blank'
      if (!isAllowedGuestUrl(src)) {
        log.warn('blocked guest attach for %s', src)
        event.preventDefault()
        return
      }
      // Loopback must mean the runtime's machine: only a prepared workspace
      // partition, routed through its proxy, may host a guest.
      const partition = typeof webPreferences.partition === 'string' ? webPreferences.partition : ''
      if (!options.isPreparedPartition(partition)) {
        log.warn('blocked guest attach: partition %s is not a prepared workspace partition', partition || '(default)')
        event.preventDefault()
        return
      }
      // Pin the guest preload; never trust one the renderer supplied.
      ;(webPreferences as { preload?: string }).preload = options.guestPreload
      delete (webPreferences as { preloadURL?: string }).preloadURL
      webPreferences.nodeIntegration = false
      webPreferences.contextIsolation = true
      webPreferences.sandbox = true
      webPreferences.webSecurity = true
      ;(webPreferences as { allowRunningInsecureContent?: boolean }).allowRunningInsecureContent = false
      // Popups reach the window-open handler, which turns them into tabs.
      params.allowpopups = 'true'
      configureGuestSession(electronSession.fromPartition(partition), platform)
    })
  })
}

/** The app's own pages: a strict CSP on the renderer's documents. */
export function installAppCsp(rendererUrl: string | undefined): void {
  electronSession.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const url = details.url
    if (!url.startsWith('file://') && !(rendererUrl && url.startsWith(rendererUrl))) {
      callback({})
      return
    }
    const dev = rendererUrl ? " 'unsafe-inline' 'unsafe-eval'" : ''
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self'; script-src 'self'${dev}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' https: ws: wss: sentry-ipc:; font-src 'self' data:; base-uri 'self'`,
        ],
      },
    })
  })
}
