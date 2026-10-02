// Which web hosts name the runtime's machine (architecture D10, 12.3). A
// loopback URL is always a page on the runtime's machine: it opens only in a
// loopback-routed webview (a browser panel), never in a client's system
// browser.

/** `localhost`, `*.localhost`, `127.0.0.0/8`, `0.0.0.0`, `[::1]` and `[::]`,
 *  any port. IPv6 may come with or without brackets. */
export function isLoopbackHostname(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  return name === 'localhost'
    || name.endsWith('.localhost')
    || /^127(?:\.\d{1,3}){3}$/.test(name)
    || name === '0.0.0.0'
    || name === '::1'
    || name === '::'
}

/** An `http:` or `https:` URL whose host is loopback. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && isLoopbackHostname(parsed.hostname)
  } catch {
    return false
  }
}
