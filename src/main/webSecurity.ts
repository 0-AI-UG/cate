import { app, session, shell, type Session, type WebContents } from 'electron'
import log from './logger'
import { disableWebviewHardening } from './featureFlags'

// Hosts whose OAuth/sign-in flows are forced into the user's real browser via
// shell.openExternal (see installWebContentsSecurity below) rather than running
// inside the webview — Electron's webview is flagged by these providers as an
// "insecure browser" and blocks the flow.
//
// Note (issue #220): this is by design and independent of the browser panel's
// persistent session. Even though all browser panels now share a stable
// persistent partition so cookies/logins survive restarts (see BROWSER_PARTITION
// in BrowserPanel.tsx), "Sign in with Google/Microsoft/Apple/GitHub" still
// completes in the system browser, not in-app. In-webview OAuth for these
// providers is intentionally not supported.
const OAUTH_HOSTS = new Set([
  'accounts.google.com',
  'login.microsoftonline.com',
  'appleid.apple.com',
])

function isOAuthUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (OAUTH_HOSTS.has(parsed.host)) return true
    if (parsed.host === 'github.com' && parsed.pathname.startsWith('/login/oauth')) return true
    return false
  } catch {
    return false
  }
}

const configuredGuestSessions = new Set<string>()

export function isTrustedAppUrl(url: string): boolean {
  if (url.startsWith('file://')) return true
  if (!process.env.ELECTRON_RENDERER_URL) return false
  try {
    return new URL(url).origin === new URL(process.env.ELECTRON_RENDERER_URL).origin
  } catch {
    return false
  }
}

export function isAllowedGuestUrl(url: string): boolean {
  if (url === 'about:blank') return true
  try {
    const parsed = new URL(url)
    // Allow file: so the browser panel can render local HTML files explicitly
    // requested by the user via the address bar. Cross-origin reads from a
    // remote page into file:// are blocked by the same-origin policy.
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'file:'
  } catch {
    return false
  }
}

function configureGuestSessionPolicies(targetSession: Session, sessionKey: string): void {
  if (configuredGuestSessions.has(sessionKey)) return
  configuredGuestSessions.add(sessionKey)

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

function guestSessionFor(contents: WebContents, partition?: string): Session {
  if (partition) return session.fromPartition(partition)
  return contents.session
}

export function installWebContentsSecurity(): void {
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() === 'webview') {
      contents.on('will-navigate', (event, url) => {
        if (isOAuthUrl(url)) {
          event.preventDefault()
          shell.openExternal(url)
        }
      })

      contents.setWindowOpenHandler(({ url }) => {
        if (isOAuthUrl(url)) {
          shell.openExternal(url)
        }
        return { action: 'deny' }
      })
    } else {
      contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    }

    if (contents.getType() === 'window') {
      contents.on('will-navigate', (event, url) => {
        if (!isTrustedAppUrl(url)) {
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

      // Browser screenshots are captured from the main process via
      // webContents.capturePage(); guest preload is not required for them.
      delete (webPreferences as { preload?: string }).preload
      delete (webPreferences as { preloadURL?: string }).preloadURL
      webPreferences.nodeIntegration = false
      webPreferences.contextIsolation = true
      webPreferences.sandbox = true
      webPreferences.webSecurity = true
      ;(webPreferences as { allowRunningInsecureContent?: boolean }).allowRunningInsecureContent = false

      // Allow `window.open()` from webview content so we can track OAuth /
      // Sign-In popups via Cate's popup registry. The setWindowOpenHandler
      // installed when the guest's webContents is created strictly filters
      // which URLs are actually allowed; this just removes the blanket veto.
      params.allowpopups = 'true'

      const partition = typeof webPreferences.partition === 'string' ? webPreferences.partition : undefined
      const targetSession = guestSessionFor(contents, partition)
      configureGuestSessionPolicies(targetSession, partition ?? '__default__')
    })
  })
}
