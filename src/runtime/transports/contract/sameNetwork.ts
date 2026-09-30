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
