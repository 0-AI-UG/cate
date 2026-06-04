// =============================================================================
// browserProxy — per-panel HTTP/HTTPS/SOCKS5/PAC proxy for Browser nodes
// (issue #241)
//
// Each browser panel that has a proxy configured runs in its own proxy-derived
// persistent session (see BrowserPanel.tsx `partitionFor`). This module applies
// the proxy to that session and answers Chromium's proxy auth challenge for
// credentialed proxies (`user:pass@host`), since the credentials cannot be
// carried in the proxy rules string itself.
// =============================================================================

import { app, session, type Session } from 'electron'
import log from './logger'

interface ProxyCredentials {
  username: string
  password: string
}

// Credentials are keyed by Session identity (not partition string): the `login`
// event hands us the guest's webContents, from which we recover the same Session
// instance `session.fromPartition` returned. A WeakMap lets dead sessions GC.
const proxyCredentials = new WeakMap<Session, ProxyCredentials>()

const PAC_PREFIX = 'pac://'

/** Configure proxy settings for an Electron session partition. Idempotent —
 *  safe to call again when the panel's proxy changes. */
export async function configureBrowserProxy(partition: string, proxyUrl?: string): Promise<void> {
  const ses = session.fromPartition(partition)

  const trimmed = proxyUrl?.trim()
  if (!trimmed) {
    proxyCredentials.delete(ses)
    await ses.setProxy({ mode: 'direct' })
    return
  }

  if (trimmed.startsWith(PAC_PREFIX)) {
    // pac://file:///path/to/proxy.pac → pacScript expects the URL after `pac://`
    proxyCredentials.delete(ses)
    await ses.setProxy({ mode: 'pac_script', pacScript: trimmed.slice(PAC_PREFIX.length) })
    return
  }

  // Split an optional `;bypass=host1,host2` suffix off the server spec.
  const [serverPart, bypassPart] = trimmed.split(';bypass=')
  const bypassRules = bypassPart
    ? bypassPart.split(',').map((r) => r.trim()).filter(Boolean).join(',')
    : undefined

  // Extract and strip any `user:pass@` credentials — Chromium's proxyRules
  // string cannot carry them; they are supplied via the `login` event instead.
  const { rules, credentials } = parseProxyServer(serverPart)
  if (credentials) proxyCredentials.set(ses, credentials)
  else proxyCredentials.delete(ses)

  await ses.setProxy({
    mode: 'fixed_servers',
    proxyRules: rules,
    proxyBypassRules: bypassRules,
  })
}

/** Parse a proxy server spec, returning the credential-free rules string for
 *  Electron and any embedded credentials. Falls back to the raw input when the
 *  spec can't be parsed as a URL (e.g. bare `host:port`). */
function parseProxyServer(server: string): { rules: string; credentials: ProxyCredentials | null } {
  const spec = server.trim()
  try {
    const u = new URL(spec)
    const credentials = u.username
      ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }
      : null
    // protocol includes the trailing ':'; host includes the port when present.
    const rules = `${u.protocol}//${u.host}`
    return { rules, credentials }
  } catch {
    return { rules: spec, credentials: null }
  }
}

/** Install the single app-wide proxy auth handler. Answers Chromium's auth
 *  challenge for proxies configured with embedded credentials. Call once at
 *  startup. */
export function installProxyAuthHandler(): void {
  app.on('login', (event, webContents, _details, authInfo, callback) => {
    if (!authInfo.isProxy) return // let normal site auth fall through to default
    const creds = webContents ? proxyCredentials.get(webContents.session) : undefined
    if (!creds) return
    event.preventDefault()
    log.info('[browserProxy] Supplying proxy credentials for %s:%d', authInfo.host, authInfo.port)
    callback(creds.username, creds.password)
  })
}
