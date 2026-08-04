import { app, session, type Session, type WebContents } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import log from './logger'
import { disableWebviewHardening } from './featureFlags'
import { BROWSER_SHORTCUT } from '../shared/ipc-channels'
import type { BrowserShortcutAction } from '../shared/types'
import { getProxyOrigin, getCateHostPreloadPath } from './extensions/proxyServer'

/** True iff `url` is served by the local extension proxy (an extension guest).
 *  Such guests keep their cateHost preload (the reverse-API bridge) rather than
 *  having it stripped like a plain browser-panel webview. */
function isExtensionProxyUrl(url: string): boolean {
  const origin = getProxyOrigin()
  if (!origin) return false
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}

function getBrowserGuestPreloadPath(): string {
  const base =
    typeof __dirname !== 'undefined'
      ? __dirname
      : path.dirname(fileURLToPath(import.meta.url))
  return path.join(base, '../preload/browserGuest.js')
}

export { getBrowserGuestPreloadPath }

/** Map a webview guest key event to a browser navigation action. Returns null
 *  for keys we don't own, so the guest page handles them normally. Uses
 *  `input.code` (layout-independent) rather than `input.key`. */
function browserActionForInput(input: Electron.Input): BrowserShortcutAction | null {
  if (input.type !== 'keyDown') return null
  const mod = process.platform === 'darwin' ? input.meta : input.control
  if (!mod) return null
  switch (input.code) {
    case 'KeyR':
      return input.shift ? 'reloadHard' : 'reload'
    case 'KeyL':
      return input.shift ? null : 'focusUrl'
    case 'BracketLeft':
      return input.shift ? null : 'back'
    case 'BracketRight':
      return input.shift ? null : 'forward'
    default:
      return null
  }
}

const configuredGuestSessions = new WeakSet<Session>()
const browserGuestSessions = new WeakSet<Session>()
const browserGuestSessionPaths = new Set<string>()
const browserPopupContents = new WeakSet<WebContents>()

function isBrowserGuestSession(targetSession: Session): boolean {
  return browserGuestSessions.has(targetSession)
    || Boolean(targetSession.storagePath && browserGuestSessionPaths.has(targetSession.storagePath))
}

function isTrustedAppUrl(url: string): boolean {
  if (url.startsWith('file://')) return true
  if (!process.env.ELECTRON_RENDERER_URL) return false
  try {
    return new URL(url).origin === new URL(process.env.ELECTRON_RENDERER_URL).origin
  } catch {
    return false
  }
}

function isAllowedGuestUrl(url: string): boolean {
  if (url === 'about:blank') return true
  try {
    const parsed = new URL(url)
    // Allow file: so the browser panel can render local HTML files explicitly
    // requested by the user via the address bar. Cross-origin reads from a
    // remote page into file:// are blocked by the same-origin policy.
    // data: is useful for self-contained agent fixtures and remains isolated:
    // browser guests are sandboxed, have no Node integration, and receive only
    // the one-way password-focus preload.
    return parsed.protocol === 'http:'
      || parsed.protocol === 'https:'
      || parsed.protocol === 'file:'
      || parsed.protocol === 'data:'
  } catch {
    return false
  }
}

function headerName(headers: Record<string, string[] | string>, wanted: string): string {
  return Object.keys(headers).find((name) => name.toLowerCase() === wanted.toLowerCase()) ?? wanted
}

function browserUserAgent(targetSession: Session): string {
  const product = app.getName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return targetSession.getUserAgent()
    .replace(/\sElectron\/[^\s]+/g, '')
    .replace(new RegExp(`\\s${product}/[^\\s]+`, 'g'), '')
}

function configureBrowserIdentity(targetSession: Session): void {
  browserGuestSessions.add(targetSession)
  if (targetSession.storagePath) browserGuestSessionPaths.add(targetSession.storagePath)
  const userAgent = browserUserAgent(targetSession)
  targetSession.setUserAgent(userAgent, app.getLocale())

  targetSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }
    headers[headerName(headers, 'User-Agent')] = userAgent
    const chromeMajor = /\b(?:Chrome|Chromium)\/(\d+)\./.exec(userAgent)?.[1]
    if (chromeMajor) {
      headers[headerName(headers, 'sec-ch-ua')] =
        `"Chromium";v="${chromeMajor}", "Google Chrome";v="${chromeMajor}", "Not=A?Brand";v="24"`
      headers[headerName(headers, 'sec-ch-ua-mobile')] = '?0'
      headers[headerName(headers, 'sec-ch-ua-platform')] =
        process.platform === 'darwin' ? '"macOS"' : process.platform === 'win32' ? '"Windows"' : '"Linux"'
    }
    callback({ requestHeaders: headers })
  })
}

function configureGuestSessionPolicies(
  targetSession: Session,
  browserGuest: boolean,
): void {
  if (configuredGuestSessions.has(targetSession)) return
  configuredGuestSessions.add(targetSession)

  if (browserGuest) configureBrowserIdentity(targetSession)

  const allowedPermissions = new Set(['cookies', 'storage-access'])

  targetSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (allowedPermissions.has(permission)) {
      callback(true)
      return
    }
    log.warn('[webview] Denied guest permission request: %s', permission)
    callback(false)
  })

  targetSession.setPermissionCheckHandler((_wc, permission) => allowedPermissions.has(permission))

  targetSession.webRequest.onBeforeRequest((details, callback) => {
    if (details.resourceType === 'mainFrame' && !isAllowedGuestUrl(details.url)) {
      log.warn('[webview] Blocked guest navigation to %s', details.url)
      callback({ cancel: true })
      return
    }
    callback({})
  })
}

/** Apply the browser-panel session policy to a main-owned WebContentsView. */
export function configureBrowserGuestSession(targetSession: Session): void {
  configureGuestSessionPolicies(targetSession, true)
}

/** Apply browser guest navigation, popup and shortcut policy to non-webview
 *  embedded contents. WebContentsView has no hostWebContents, so its owning
 *  Cate renderer is supplied explicitly for shortcut forwarding. */
export function installBrowserGuestContents(contents: WebContents, host: WebContents): void {
  contents.on('will-navigate', (event, url) => {
    if (!isAllowedGuestUrl(url)) {
      log.warn('[browser] Blocked guest navigation to %s', url)
      event.preventDefault()
    }
  })
  installBrowserPopupHandler(contents)
  contents.on('before-input-event', (event, input) => {
    const action = browserActionForInput(input)
    if (!action) return
    event.preventDefault()
    if (!host.isDestroyed()) host.send(BROWSER_SHORTCUT, action)
  })
}

function installBrowserPopupHandler(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (!isBrowserGuestSession(contents.session) || !isAllowedGuestUrl(url)) {
      log.warn('[browser] Blocked popup navigation to %s', url)
      return { action: 'deny' }
    }
    return {
      action: 'allow',
      outlivesOpener: false,
      overrideBrowserWindowOptions: {
        width: 520,
        height: 720,
        show: false,
        autoHideMenuBar: true,
        title: 'Sign in',
        webPreferences: {
          session: contents.session,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
        },
      },
    }
  })

  contents.on('did-create-window', (popup) => {
    browserPopupContents.add(popup.webContents)
    installBrowserPopupHandler(popup.webContents)
    popup.setMenuBarVisibility(false)
    popup.once('ready-to-show', () => {
      if (!popup.isDestroyed()) popup.show()
    })
  })
}

function guestSessionFor(contents: WebContents, partition?: string): Session {
  if (partition) return session.fromPartition(partition)
  return contents.session
}

export function installWebContentsSecurity(): void {
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() === 'webview') {
      contents.on('will-navigate', (event, url) => {
        if (!isAllowedGuestUrl(url)) {
          log.warn('[browser] Blocked guest navigation to %s', url)
          event.preventDefault()
        }
      })

      installBrowserPopupHandler(contents)

      // Capture browser navigation keys (Cmd+R/[/]/L) even when the guest page
      // has keyboard focus, and forward them to the embedding renderer so the
      // focused BrowserPanel can act. Scoped to webview guests, so Monaco's
      // Cmd+[ / Cmd+] / Cmd+L are never affected.
      contents.on('before-input-event', (event, input) => {
        const action = browserActionForInput(input)
        if (!action) return
        event.preventDefault()
        try {
          contents.hostWebContents?.send(BROWSER_SHORTCUT, action)
        } catch {
          /* host gone — ignore */
        }
      })
    } else {
      contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    }

    if (contents.getType() === 'window') {
      contents.on('will-navigate', (event, url) => {
        // WebContentsView currently reports `window` here too. Its session is
        // configured before construction, so use that identity to keep remote
        // browser navigation out of the app-window allowlist.
        const allowed = browserPopupContents.has(contents) || isBrowserGuestSession(contents.session)
          ? isAllowedGuestUrl(url)
          : isTrustedAppUrl(url)
        if (!allowed) {
          log.warn('[security] Blocked app-window navigation to %s', url)
          event.preventDefault()
        }
      })
    }

    contents.on('will-attach-webview', (event, webPreferences, params) => {
      if (disableWebviewHardening()) return

      const src = typeof params.src === 'string' ? params.src : 'about:blank'
      if (!isAllowedGuestUrl(src)) {
        log.warn('[webview] Blocked guest attach for URL %s', src)
        event.preventDefault()
        return
      }

      // Never trust the preload path supplied by the renderer. Extension guests
      // get the canonical cateHost bridge; ordinary browser guests get a
      // separate one-way focus observer used by password autofill. Neither
      // preload exposes Node or app APIs to remote page JavaScript.
      const extensionGuest = isExtensionProxyUrl(src)
      if (extensionGuest) {
        ;(webPreferences as { preload?: string }).preload = getCateHostPreloadPath()
        delete (webPreferences as { preloadURL?: string }).preloadURL
        log.info('[webview] Pinned cateHost preload for extension guest %s', src)
      } else {
        ;(webPreferences as { preload?: string }).preload = getBrowserGuestPreloadPath()
        delete (webPreferences as { preloadURL?: string }).preloadURL
      }
      webPreferences.nodeIntegration = false
      webPreferences.contextIsolation = true
      webPreferences.sandbox = true
      webPreferences.webSecurity = true
      ;(webPreferences as { allowRunningInsecureContent?: boolean }).allowRunningInsecureContent = false

      // Allow `window.open()` from webview content so we can track OAuth /
      // Sign-In popups via Cate's popup registry. The setWindowOpenHandler
      // installed when the guest's webContents is created strictly filters
      // which URLs are actually allowed; this just removes the blanket veto.
      if (!extensionGuest) params.allowpopups = 'true'

      const partition = typeof webPreferences.partition === 'string' ? webPreferences.partition : undefined
      const targetSession = guestSessionFor(contents, partition)
      configureGuestSessionPolicies(targetSession, !extensionGuest)
    })
  })
}
