import { app, session, type Session, type WebContents } from 'electron'
import log from './logger'
import { disableWebviewHardening } from './featureFlags'

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
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function configureGuestSessionPolicies(targetSession: Session, sessionKey: string): void {
  if (configuredGuestSessions.has(sessionKey)) return
  configuredGuestSessions.add(sessionKey)

  targetSession.setPermissionRequestHandler((_wc, permission, callback) => {
    log.warn('[webview] Denied guest permission request: %s', permission)
    callback(false)
  })

  targetSession.setPermissionCheckHandler(() => false)

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
    // Default: deny popups for every web-contents. Webview guests get a
    // permissive handler installed below that allows popups but routes them
    // through Cate's popup registry so the agent can drive them via the
    // `cate portal` CLI.
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))

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
