import { cleanProviderAuthOutput } from './providerAuth'

/** Only offer complete loopback requests; the hosted page requires a callback port. */
export function remoteAuthorizationUrl(output: string): string | undefined {
  const urls = cleanProviderAuthOutput(output).match(/https:\/\/[^\s<>"']+(?=\s)/g) ?? []
  for (const raw of urls) {
    try {
      const url = new URL(raw.replace(/[),.;]+$/, ''))
      if (url.protocol !== 'https:' || url.hostname !== 'app.t3.codes' || url.pathname !== '/connect') continue
      const request = new URLSearchParams(url.hash.slice(1))
      const port = request.get('port') ?? ''
      if (/^[A-Za-z0-9_-]{22}$/.test(request.get('state') ?? '')
        && /^[A-Za-z0-9_-]{43}$/.test(request.get('challenge') ?? '')
        && /^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535) return url.toString()
    } catch { /* Ignore incomplete terminal output. */ }
  }
  return undefined
}
