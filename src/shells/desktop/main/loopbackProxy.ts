// The loopback web proxy of one workspace (architecture 12.3). A workspace's
// browser partition routes every request here. Loopback hosts go to the
// runtime's machine through the workspace connection's `dialLoopback(port)`;
// every other host is reached directly, or through the client's upstream
// `browserProxyUrl`. Plain HTTP, CONNECT and upgrades (WebSocket); pages are
// never rewritten. A per-launch credential keeps other local processes out.

import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { Duplex } from 'node:stream'
import type { ByteDuplex } from '@kernel/rpc/contract'
import { createLogger } from '@kernel/log/contract'
import { isLoopbackHostname } from '@runtime/tunnel/contract'

const log = createLogger('loopback-proxy')

export interface ProxyCredentials { username: string; password: string }

export interface LoopbackProxyOptions {
  /** A pipe to `port` on the runtime's machine. */
  dialLoopback(port: number): Promise<ByteDuplex>
  /** A TCP connection to a non-loopback host. Default `net.connect`. */
  dialDirect?(host: string, port: number): Promise<Duplex>
  /** The client's `browserProxyUrl`, read per request. Only `http://` upstreams
   *  are supported here; anything else connects directly. */
  upstream?(): string | undefined
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
  try { parsed = new URL(trimmed.split(';bypass=')[0]) } catch { return null }
  if (parsed.protocol !== 'http:') return null
  const authorization = parsed.username
    ? `Basic ${Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString('base64')}`
    : undefined
  return { host: parsed.hostname, port: Number(parsed.port || 80), ...(authorization ? { authorization } : {}) }
}

function directConnect(host: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host)
    socket.once('connect', () => { socket.removeListener('error', reject); resolve(socket) })
    socket.once('error', reject)
  })
}

/** A tunnel through an HTTP upstream proxy. */
async function upstreamConnect(upstream: Upstream, host: string, port: number, dial: (h: string, p: number) => Promise<Duplex>): Promise<Duplex> {
  const socket = await dial(upstream.host, upstream.port)
  const authority = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf('\r\n\r\n')
      if (end < 0) return
      socket.removeListener('data', onData)
      socket.removeListener('error', reject)
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
    socket.once('error', reject)
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${upstream.authorization ? `Proxy-Authorization: ${upstream.authorization}\r\n` : ''}\r\n`)
  })
}

export function startLoopbackProxy(options: LoopbackProxyOptions): Promise<LoopbackProxy> {
  const dialDirect = options.dialDirect ?? directConnect
  const expected = Buffer.from(`Basic ${Buffer.from(`${options.credentials.username}:${options.credentials.password}`).toString('base64')}`)
  let warnedUpstream = false

  const authorized = (req: http.IncomingMessage): boolean => {
    const given = Buffer.from(String(req.headers['proxy-authorization'] ?? ''))
    return given.length === expected.length && crypto.timingSafeEqual(given, expected)
  }

  const upstream = (): Upstream | null => {
    const raw = options.upstream?.()
    const parsed = parseUpstream(raw)
    if (raw?.trim() && !parsed && !warnedUpstream) {
      warnedUpstream = true
      log.warn('browserProxyUrl %s is not an http:// proxy; connecting directly', raw.split('@').pop())
    }
    return parsed
  }

  /** A raw byte stream to host:port, wherever it lives. */
  const openRaw = async (host: string, port: number): Promise<Duplex> => {
    if (isLoopbackHostname(host)) return byteDuplexStream(await options.dialLoopback(port))
    const up = upstream()
    return up ? upstreamConnect(up, host, port, dialDirect) : dialDirect(host, port)
  }

  const deny = (socket: Duplex, status = '407 Proxy Authentication Required') => {
    socket.end(`HTTP/1.1 ${status}\r\nProxy-Authenticate: Basic realm="cate"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
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
      const loopback = isLoopbackHostname(url.hostname)
      const up = loopback ? null : upstream()
      let request: http.ClientRequest
      if (up) {
        request = http.request({
          host: up.host, port: up.port, method: req.method, path: url.href, agent: false,
          headers: { ...headers, ...(up.authorization ? { 'proxy-authorization': up.authorization } : {}) },
        }, onResponse)
      } else {
        const stream = loopback ? byteDuplexStream(await options.dialLoopback(port)) : await dialDirect(url.hostname, port)
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
    let stream: Duplex
    try {
      stream = await openRaw(target.host, target.port)
    } catch (error) {
      log.debug('CONNECT %s failed: %s', req.url, (error as Error).message)
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      return
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length > 0) stream.write(head)
    splice(socket, stream)
  })

  server.on('upgrade', async (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!authorized(req)) return deny(socket)
    let url: URL
    try { url = new URL(req.url ?? '') } catch { return deny(socket, '400 Bad Request') }
    const port = Number(url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80))
    let stream: Duplex
    try {
      stream = await openRaw(url.hostname, port)
    } catch {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      return
    }
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
