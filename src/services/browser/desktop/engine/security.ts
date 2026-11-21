import { app, type Session, type WebContents } from 'electron'

export function allowedPageUrl(value: unknown): value is string {
  if (value === 'about:blank') return true
  if (typeof value !== 'string') return false
  try { return ['http:', 'https:', 'data:'].includes(new URL(value).protocol) } catch { return false }
}

const configured = new WeakSet<Session>()
export function secureBrowserSession(session: Session): void {
  if (configured.has(session)) return
  configured.add(session)
  const product = app.getName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const agent = session.getUserAgent().replace(/\sElectron\/\S+/g, '').replace(new RegExp(`\\s${product}/\\S+`, 'g'), '')
  session.setUserAgent(agent, app.getLocale())
  const chrome = /\b(?:Chrome|Chromium)\/(\d+)\./.exec(agent)?.[1]
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }
    const name = (key: string) => Object.keys(headers).find(candidate => candidate.toLowerCase() === key) ?? key
    headers[name('user-agent')] = agent
    if (chrome) {
      headers[name('sec-ch-ua')] = `"Chromium";v="${chrome}", "Google Chrome";v="${chrome}", "Not=A?Brand";v="24"`
      headers[name('sec-ch-ua-mobile')] = '?0'
      headers[name('sec-ch-ua-platform')] = process.platform === 'darwin' ? '"macOS"' : process.platform === 'win32' ? '"Windows"' : '"Linux"'
    }
    callback({ requestHeaders: headers })
  })
  const allowed = new Set(['cookies', 'storage-access'])
  session.setPermissionRequestHandler((_page, permission, callback) => callback(allowed.has(permission)))
  session.setPermissionCheckHandler((_page, permission) => allowed.has(permission))
  session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.resourceType === 'mainFrame' && !allowedPageUrl(details.url) }))
}

export function secureBrowserPage(page: WebContents): void {
  page.on('will-navigate', (event, url) => { if (!allowedPageUrl(url)) event.preventDefault() })
  page.on('will-redirect', (event, url) => { if (!allowedPageUrl(url)) event.preventDefault() })
}
