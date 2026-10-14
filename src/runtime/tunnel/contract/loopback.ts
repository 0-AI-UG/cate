// Which web hosts name the runtime's machine (architecture D10, 12.3). A
// loopback URL is always a page on the runtime's machine: it opens only in a
// loopback-routed webview (a browser panel), never in a client's system
// browser.

/** `localhost`, `*.localhost`, `127.0.0.0/8` (also IPv4-mapped, as
 *  `::ffff:127.0.0.1` or `::ffff:7f00:1`), `0.0.0.0`, `[::1]` and `[::]`, any
 *  port. IPv6 may come with or without brackets. A name that only resolves to
 *  loopback is not caught here: the browser proxy decides on the address. */
export function isLoopbackHostname(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  return name === 'localhost'
    || name.endsWith('.localhost')
    || /^(?:::ffff:)?127(?:\.\d{1,3}){3}$/.test(name)
    || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(name)
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
