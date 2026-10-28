import type { ProxyConfig } from 'electron'
import type { ProxyCredentials } from './loopbackProxy'

/** Chromium owns ordinary browsing, including system proxy discovery. A PAC
 * URL can end in .pac, or use pac+https:// for endpoints without that suffix. */
export function browserProxyConfig(value: string | undefined): ProxyConfig {
  const raw = value?.trim() ?? ''
  if (!raw) return { mode: 'system' }
  if (raw.startsWith('pac+')) return { mode: 'pac_script', pacScript: raw.slice(4) }
  if (/^https?:\/\/[^;]+\.pac(?:[?#].*)?$/i.test(raw)) return { mode: 'pac_script', pacScript: raw }
  const [rules, bypass = ''] = raw.split(';bypass=')
  // Chromium takes proxy credentials through its login event, not proxyRules.
  const authenticated = authenticatedBrowserProxy(raw)
  const proxyRules = authenticated ? authenticated.server : rules
  return { mode: 'fixed_servers', proxyRules, proxyBypassRules: bypass }
}

export function authenticatedBrowserProxy(value: string | undefined): {
  host: string; port: number; server: string; credentials: ProxyCredentials
} | null {
  try {
    const url = new URL((value ?? '').trim().split(';bypass=')[0])
    if (!['http:', 'https:'].includes(url.protocol) || !url.username) return null
    return {
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
      server: `${url.protocol}//${url.host}`,
      credentials: { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) },
    }
  } catch { return null }
}
