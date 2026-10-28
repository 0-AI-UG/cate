// The loopback web proxy of one workspace (architecture 12.3). A workspace's
// browser partition routes every request here. Loopback hosts (decided on the
// resolved address) go to the runtime's machine through the workspace
// connection's `dialLoopback(port)`; every other host is reached directly, or
// through the client's upstream `browserProxyUrl`, except that a connection
// that does not reach the client's network never gets the client's private
// ranges. Plain HTTP, CONNECT and upgrades (WebSocket); pages are never
// rewritten. A per-launch credential keeps other local processes out.

import crypto from 'node:crypto'
import dns from 'node:dns'
import http from 'node:http'
import net from 'node:net'
import { Duplex } from 'node:stream'
import type { ByteDuplex } from '@kernel/rpc/contract'
import { createLogger } from '@kernel/log/contract'
import { isLoopbackHostname } from '@runtime/tunnel/contract'
import { isPrivateAddress } from '@runtime/transports/contract'

const log = createLogger('loopback-proxy')

export interface ProxyCredentials { username: string; password: string }

export interface LoopbackProxyOptions {
  /** A pipe to `port` on the runtime's machine. */
  dialLoopback(port: number): Promise<ByteDuplex>
  /** A TCP connection to a non-loopback host. Default `net.connect`. */
  dialDirect?(host: string, port: number, addresses?: string[]): Promise<Duplex>
  /** The client's `browserProxyUrl`, read per request. This protected path
   *  supports only HTTP upstreams; unsupported settings fail closed. */
  upstream?(): string | undefined
  /** Whether the workspace connection is on the client's own network (the
   *  local socket). When it is not, the client's private ranges are refused. */
  reachesClientNetwork(): boolean
  /** Every address of a host name. Default `dns.lookup` (all). */
  lookup?(host: string): Promise<string[]>
  credentials: ProxyCredentials
}

export interface LoopbackProxy {
  readonly port: number
  close(): Promise<void>
}

export function createProxyCredentials(): ProxyCredentials {
  return { username: 'cate', password: crypto.randomBytes(24).toString('base64url') }
}

/** `host:port` of a CONNECT target (IPv6 in brackets). */
export function parseAuthority(authority: string): { host: string; port: number } | null {
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(authority)
  if (!match) return null
  const port = Number(match[3])
  if (port < 1 || port > 65_535) return null
  return { host: match[1] ?? match[2], port }
}

/** `host` as WHATWG URL parsing reads it (`2130706433` and `0x7f.1` are
 *  127.0.0.1), without IPv6 brackets; null when it is no valid host. */
export function canonicalHost(host: string): string | null {
  const bare = host.replace(/^\[|\]$/g, '')
  try {
    return new URL(`http://${bare.includes(':') ? `[${bare}]` : bare}/`).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return null
  }
}

/** `::ffff:a.b.c.d` for an IPv4-mapped address in hex form, else `address`. */
function dottedMapped(address: string): string {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address)
  if (!match) return address
  const [high, low] = [parseInt(match[1], 16), parseInt(match[2], 16)]
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
}

/** Where a request goes: the runtime's machine, a host with pinned permitted
 * addresses (or a name resolved by an upstream proxy), or nowhere. */
export type ProxyRoute = { kind: 'loopback' } | { kind: 'direct'; host: string; addresses?: string[] } | { kind: 'refused' }

export interface RouteDeps {
  lookup(host: string): Promise<string[]>
  reachesClientNetwork: boolean
  /** An upstream proxy is configured: it gets the name (its ACLs may be by
   *  name), also one the client cannot resolve. */
  upstream: boolean
}

/**
 * Decides on the address, not the name: a name that resolves to loopback is
 * the runtime's machine too (D10), and the address checked is the one
 * connected to, so a second lookup cannot rebind it. Private, link-local and
 * unique local addresses are refused unless the connection reaches the
 * client's network.
 */
export async function routeFor(host: string, deps: RouteDeps): Promise<ProxyRoute> {
  const name = canonicalHost(host)
  if (!name) return { kind: 'refused' }
  if (isLoopbackHostname(name)) return { kind: 'loopback' }
  const address = name
  if (!net.isIP(name)) {
    let addresses: string[]
    try {
      addresses = await deps.lookup(name)
    } catch (error) {
      if (deps.upstream) return { kind: 'direct', host: name }
      throw error
    }
    if (addresses.length === 0) throw new Error(`${name} has no address`)
    if (addresses.some((entry) => isLoopbackHostname(dottedMapped(entry)))) return { kind: 'loopback' }
    // Keep the checked addresses pinned, but let Node's built-in family
    // selection try alternatives. Never re-resolve the name while connecting.
    const permitted = deps.reachesClientNetwork ? addresses : addresses.filter((entry) => !isPrivateAddress(dottedMapped(entry)))
    if (permitted.length === 0) return { kind: 'refused' }
    if (deps.upstream) {
      // An upstream resolves the name itself: do not pass it a name with a
      // known private answer that it could choose instead of a public one.
      if (permitted.length !== addresses.length) return { kind: 'refused' }
      return { kind: 'direct', host: name }
    }
    return { kind: 'direct', host: name, addresses: permitted }
  }
  const plain = dottedMapped(address)
  if (isLoopbackHostname(plain)) return { kind: 'loopback' }
  if (!deps.reachesClientNetwork && isPrivateAddress(plain)) return { kind: 'refused' }
  return { kind: 'direct', host: deps.upstream ? name : address }
}

async function lookupAll(host: string): Promise<string[]> {
  return (await dns.promises.lookup(host, { all: true, verbatim: true })).map((entry) => entry.address)
}

/** A kernel/rpc byte pipe as a Node stream, for `http.request` and piping. */
function byteDuplexStream(pipe: ByteDuplex): Duplex {
  let closed = false
  const stream = new Duplex({
    allowHalfOpen: false,
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      if (!closed) pipe.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
      callback()
    },
    destroy(error, callback) {
      if (!closed) {
        closed = true
        pipe.close(error?.message)
      }
      callback(error)
    },
  })
  pipe.onData((bytes) => { stream.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)) })
  pipe.onClose(() => {
    closed = true
    stream.push(null)
  })
  return stream
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

function forwardHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name)) out[name] = value
  }
  return out
}

/** Raw request head for an upgrade, with the proxy's own headers removed. */
function upgradeHead(req: http.IncomingMessage, path: string): string {
  const lines = [`${req.method} ${path} HTTP/1.1`]
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]
    const lower = name.toLowerCase()
    if (lower === 'proxy-authorization' || lower === 'proxy-connection') continue
    lines.push(`${name}: ${req.rawHeaders[i + 1]}`)
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}

interface Upstream { host: string; port: number; authorization?: string }

function parseUpstream(url: string | undefined): Upstream | null {
  const trimmed = url?.trim()
  if (!trimmed) return null
  let parsed: URL
  try { parsed = new URL(trimmed) } catch { throw new Error('protected browser routing requires an HTTP proxy URL') }
  if (parsed.protocol !== 'http:' || trimmed.includes(';bypass=')) throw new Error('protected browser routing requires an HTTP proxy URL without bypass rules')
  const authorization = parsed.username
    ? `Basic ${Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString('base64')}`
    : undefined
  return { host: parsed.hostname, port: Number(parsed.port || 80), ...(authorization ? { authorization } : {}) }
}

export function connectProxyTarget(host: string, port: number, addresses?: string[]): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({
      port, host, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250,
      ...(addresses ? { lookup: ((_host, _options, callback) => {
        callback(null, addresses.map((address) => ({ address, family: net.isIP(address) })))
      }) satisfies net.LookupFunction } : {}),
    })
    const timer = setTimeout(() => socket.destroy(new Error(`connection to ${host}:${port} timed out`)), 15_000)
    socket.once('connect', () => { clearTimeout(timer); socket.removeListener('error', onError); resolve(socket) })
    const onError = (error: Error) => { clearTimeout(timer); reject(error) }
    socket.once('error', onError)
  })
}

/** A tunnel through an HTTP upstream proxy. */
async function upstreamConnect(upstream: Upstream, host: string, port: number, dial: (h: string, p: number) => Promise<Duplex>): Promise<Duplex> {
  const socket = await dial(upstream.host, upstream.port)
  const authority = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0)
    const cleanup = () => {
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', fail)
      socket.removeListener('end', ended)
      socket.removeListener('close', ended)
    }
    const fail = (error: Error) => { cleanup(); socket.destroy(); reject(error) }
    const ended = () => fail(new Error('upstream proxy closed before CONNECT completed'))
    const timer = setTimeout(() => fail(new Error('upstream proxy CONNECT timed out')), 15_000)
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf('\r\n\r\n')
      if (end < 0) return
      cleanup()
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(buffered.subarray(0, end).toString('latin1'))?.[1]
      if (status !== '200') {
        socket.destroy()
        reject(new Error(`upstream proxy refused CONNECT (${status ?? 'no status'})`))
        return
      }
      const rest = buffered.subarray(end + 4)
      if (rest.length > 0) socket.unshift(rest)
      resolve(socket)
    }
    socket.on('data', onData)
    socket.once('error', fail)
    socket.once('end', ended)
    socket.once('close', ended)
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${upstream.authorization ? `Proxy-Authorization: ${upstream.authorization}\r\n` : ''}\r\n`)
  })
}

export function startLoopbackProxy(options: LoopbackProxyOptions): Promise<LoopbackProxy> {
  const dialDirect = options.dialDirect ?? connectProxyTarget
  const lookup = options.lookup ?? lookupAll
  const expected = Buffer.from(`Basic ${Buffer.from(`${options.credentials.username}:${options.credentials.password}`).toString('base64')}`)

  const authorized = (req: http.IncomingMessage): boolean => {
    const given = Buffer.from(String(req.headers['proxy-authorization'] ?? ''))
    return given.length === expected.length && crypto.timingSafeEqual(given, expected)
  }

  const upstream = (): Upstream | null => parseUpstream(options.upstream?.())

  const route = (host: string, up: Upstream | null) =>
    routeFor(host, { lookup, reachesClientNetwork: options.reachesClientNetwork(), upstream: up !== null })

  /** A raw byte stream to host:port, wherever it lives; null when refused. */
  const openRaw = async (host: string, port: number): Promise<Duplex | null> => {
    const up = upstream()
    const to = await route(host, up)
    if (to.kind === 'refused') return null
    if (to.kind === 'loopback') return byteDuplexStream(await options.dialLoopback(port))
    return up ? upstreamConnect(up, to.host, port, dialDirect) : dialDirect(to.host, port, to.addresses)
  }

  const deny = (socket: Duplex, status = '407 Proxy Authentication Required') => {
    socket.end(`HTTP/1.1 ${status}\r\nProxy-Authenticate: Basic realm="cate"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
  }
  const refuse = (socket: Duplex) => {
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
  }

  // CONNECT and upgrade sockets leave the http server's bookkeeping.
  const tunnels = new Set<Duplex>()
  const splice = (client: Duplex, target: Duplex) => {
    tunnels.add(client)
    client.once('close', () => tunnels.delete(client))
    const teardown = () => { client.destroy(); target.destroy() }
    client.on('error', teardown)
    target.on('error', teardown)
    client.on('close', () => target.destroy())
    target.on('close', () => client.destroy())
    client.pipe(target)
    target.pipe(client)
  }

  const server = http.createServer(async (req, res) => {
    if (!authorized(req)) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="cate"', 'Content-Length': 0, Connection: 'close' })
      res.end()
      return
    }
    let url: URL
    try { url = new URL(req.url ?? '') } catch {
      res.writeHead(400).end()
      return
    }
    if (url.protocol !== 'http:') {
      res.writeHead(400).end()
      return
    }
    const port = Number(url.port || 80)
    // An absolute-form request names its origin in the URL (RFC 9112 3.2.2).
    const headers = { ...forwardHeaders(req.headers), host: url.host }
    const onResponse = (upstreamRes: http.IncomingMessage) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, forwardHeaders(upstreamRes.headers))
      upstreamRes.pipe(res)
    }
    try {
      const configured = upstream()
      const to = await route(url.hostname, configured)
      if (to.kind === 'refused') {
        res.writeHead(403).end()
        return
      }
      const up = to.kind === 'loopback' ? null : configured
      let request: http.ClientRequest
      if (up) {
        request = http.request({
          host: up.host, port: up.port, method: req.method, path: url.href, agent: false,
          headers: { ...headers, ...(up.authorization ? { 'proxy-authorization': up.authorization } : {}) },
        }, onResponse)
      } else {
        const stream = to.kind === 'loopback' ? byteDuplexStream(await options.dialLoopback(port)) : await dialDirect(to.host, port, to.addresses)
        request = http.request({
          // No agent: with `agent: false` Node ignores createConnection.
          method: req.method, path: url.pathname + url.search, headers,
          createConnection: () => stream as net.Socket,
        }, onResponse)
      }
      request.on('error', (error) => {
        log.debug('request to %s failed: %s', url.host, error.message)
        if (!res.headersSent) res.writeHead(502).end()
        else res.destroy()
      })
      req.pipe(request)
    } catch (error) {
      log.debug('dial to %s failed: %s', url.host, (error as Error).message)
      if (!res.headersSent) res.writeHead(502).end()
    }
  })

  server.on('connect', async (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!authorized(req)) return deny(socket)
    const target = parseAuthority(req.url ?? '')
    if (!target) return deny(socket, '400 Bad Request')
    let stream: Duplex | null
    try {
      stream = await openRaw(target.host, target.port)
    } catch (error) {
      log.debug('CONNECT %s failed: %s', req.url, (error as Error).message)
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      return
    }
    if (!stream) return refuse(socket)
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length > 0) stream.write(head)
    splice(socket, stream)
  })

  server.on('upgrade', async (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!authorized(req)) return deny(socket)
    let url: URL
    try { url = new URL(req.url ?? '') } catch { return deny(socket, '400 Bad Request') }
    const port = Number(url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80))
    let stream: Duplex | null
    try {
      stream = await openRaw(url.hostname, port)
    } catch {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      return
    }
    if (!stream) return refuse(socket)
    stream.write(upgradeHead(req, url.pathname + url.search))
    if (head.length > 0) stream.write(head)
    splice(socket, stream)
  })

  server.on('clientError', (_error, socket) => { socket.destroy() })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const address = server.address() as net.AddressInfo
      resolve({
        port: address.port,
        close: () => new Promise<void>((done) => {
          server.close(() => done())
          server.closeAllConnections()
          for (const socket of tunnels) socket.destroy()
        }),
      })
    })
  })
}
