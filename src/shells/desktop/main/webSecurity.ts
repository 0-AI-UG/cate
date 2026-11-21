// Security for Cate UI windows. Untrusted browser pages are owned and
// secured by services/browser/desktop/engine in a separate process.

import { app, session as electronSession } from 'electron'
import { createLogger } from '@kernel/log/contract'
import { shortcutMatches, type ActionId } from '@kernel/interaction/contract'
import type { BrowserShortcutAction } from '@services/browser/contract'
import { type MenuModel } from '../contract'

const log = createLogger('security')

interface WebSecurityOptions { rendererUrl?: string }

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

/** App windows never host page content. Browser pages live in the engine. */
export function installWebSecurity(options: WebSecurityOptions): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.on('will-navigate', (event, url) => {
      if (!isTrustedAppUrl(url, options.rendererUrl)) {
        log.warn('blocked app window navigation to %s', url)
        event.preventDefault()
      }
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
          `default-src 'self'; script-src 'self'${dev}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' https: ws: wss: sentry-ipc:; font-src 'self' data:; frame-src https: http://localhost:* http://127.0.0.1:*; base-uri 'self'`,
        ],
      },
    })
  })
}
