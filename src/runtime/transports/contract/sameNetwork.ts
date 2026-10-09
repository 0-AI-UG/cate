// Same network: the runtime's LAN WebSocket and its mDNS advertisement. Pure.

/** Advertised as `_cate._tcp`. */
export const MDNS_SERVICE_TYPE = 'cate'
/** TXT record key carrying the runtimeId. */
export const MDNS_RUNTIME_ID_KEY = 'runtimeId'

/** Largest WebSocket message a peer accepts: one Noise message plus slack. */
export const NETWORK_MAX_MESSAGE = 65_535 + 1024

/** The WebSocket path names the runtime, so a stale address that now belongs
 *  to another runtime refuses the upgrade instead of starting a handshake. */
export function sameNetworkPath(runtimeId: string): string {
  return `/cate/${runtimeId}`
}

/** `host:port`, with brackets around an IPv6 host. */
export function formatAddress(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
}

export function parseAddress(address: string): { host: string; port: number } | null {
  const match = /^(?:\[([0-9a-fA-F:.%a-zA-Z]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(address.trim())
  if (!match) return null
  const port = Number(match[3])
  if (port < 1 || port > 65_535) return null
  return { host: match[1] ?? match[2], port }
}

export function sameNetworkUrl(address: string, runtimeId: string): string | null {
  const parsed = parseAddress(address)
  return parsed ? `ws://${formatAddress(parsed.host, parsed.port)}${sameNetworkPath(runtimeId)}` : null
}

/** A port picked from the runtimeId, tried first so addresses in an old
 *  pairing payload keep working across restarts. */
export function preferredPort(runtimeId: string): number {
  let hash = 0
  for (let i = 0; i < runtimeId.length; i++) hash = (hash * 31 + runtimeId.charCodeAt(i)) >>> 0
  return 49_152 + (hash % 16_384)
}

/**
 * Whether a peer address is on a private network: RFC 1918, CGNAT (which
 * Tailscale uses), link-local, loopback, and IPv6 loopback, link-local and
 * unique local. The same-network listener serves only these.
 */
export function isPrivateAddress(ip: string): boolean {
  let address = ip.trim().toLowerCase().replace(/%.*$/, '')
  if (address.startsWith('::ffff:') && address.includes('.')) address = address.slice('::ffff:'.length)
  if (address.includes('.')) {
    const parts = address.split('.')
    if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false
    const [a, b] = parts.map(Number)
    return a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || a === 127
  }
  if (address === '::1') return true
  const first = address.split(':')[0]
  if (!/^[0-9a-f]{1,4}$/.test(first)) return false
  const hextet = parseInt(first, 16)
  return (hextet >= 0xfe80 && hextet <= 0xfebf) || (hextet >= 0xfc00 && hextet <= 0xfdff)
}

/** Where a paired runtime may be reached: a LAN WebSocket address (from the
 *  pairing payload or mDNS), or through Cate Connect. */
export type NetworkEndpoint =
  | { kind: 'lan'; address: string; port: number }
  | { kind: 'connect' }

/** A paired runtime and where to reach it. */
export interface NetworkTarget {
  runtimeId: string
  endpoints: readonly NetworkEndpoint[]
}

/** The endpoints a pairing gives: its LAN addresses, and Cate Connect when
 *  the runtime pairs through it. */
export function pairingEndpoints(addresses: readonly string[], mode: 'sameNetwork' | 'cateConnect' | undefined): NetworkEndpoint[] {
  const endpoints: NetworkEndpoint[] = addresses.flatMap((address) => {
    const parsed = parseAddress(address)
    return parsed ? [{ kind: 'lan' as const, address: parsed.host, port: parsed.port }] : []
  })
  if (mode === 'cateConnect') endpoints.push({ kind: 'connect' })
  return endpoints
}
