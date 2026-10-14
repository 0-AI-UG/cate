import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { socketDuplex } from '@runtime/transports/node'
import { canonicalHost, createProxyCredentials, parseAuthority, routeFor, startLoopbackProxy, type LoopbackProxy } from './loopbackProxy'

// The target stands in for a dev server on the runtime's machine. The fake
// dialLoopback reaches it with a plain TCP connect, as a local connection does.
let target: http.Server
let targetPort: number
let wss: WebSocketServer
let proxy: LoopbackProxy
const credentials = createProxyCredentials()
const auth = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`
const loopbackDials: number[] = []
const directDials: { host: string; port: number }[] = []
let reaches = true
// Stands in for DNS.
const HOSTS: Record<string, string[]> = {
  'example.test': ['93.184.216.34'],
  'loopback.test': ['127.0.0.1'],
  'mapped.test': ['::ffff:7f00:1'],
  'lan.test': ['192.168.1.20'],
  'ula.test': ['fd00::5'],
  'mixed.test': ['93.184.216.34', '127.0.0.1'],
}
const lookup = async (host: string): Promise<string[]> => {
  const found = HOSTS[host]
  if (!found) throw new Error(`ENOTFOUND ${host}`)
  return found
}

const tcp = (port: number) => new Promise<net.Socket>((resolve, reject) => {
  const socket = net.connect(port, '127.0.0.1')
  socket.once('connect', () => resolve(socket))
  socket.once('error', reject)
})

beforeAll(async () => {
  target = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/plain')
    res.end(`${req.method} ${req.url} host=${req.headers.host} auth=${req.headers['proxy-authorization'] ?? 'none'}`)
  })
  wss = new WebSocketServer({ server: target, path: '/ws' })
  wss.on('connection', (socket) => socket.on('message', (data) => socket.send(`echo:${String(data)}`)))
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
  targetPort = (target.address() as AddressInfo).port
  proxy = await startLoopbackProxy({
    credentials,
    reachesClientNetwork: () => reaches,
    lookup,
    dialLoopback: async (port) => {
      loopbackDials.push(port)
      return socketDuplex(await tcp(port))
    },
    dialDirect: async (host, port) => {
      directDials.push({ host, port })
      return tcp(port)
    },
  })
})

afterAll(async () => {
  await proxy.close()
  for (const client of wss.clients) client.terminate()
  wss.close()
  target.closeAllConnections()
  await new Promise<void>((resolve) => target.close(() => resolve()))
})

beforeEach(() => {
  reaches = true
  loopbackDials.length = 0
  directDials.length = 0
})

function viaProxy(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxy.port, path: url, headers }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

function connectTunnel(authority: string, headers: Record<string, string>): Promise<{ status: number; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: authority, headers })
    req.on('connect', (res, socket) => resolve({ status: res.statusCode ?? 0, socket }))
    req.on('response', (res) => resolve({ status: res.statusCode ?? 0, socket: res.socket }))
    req.on('error', reject)
    req.end()
  })
}

describe('loopback web proxy', () => {
  it('routes plain HTTP to a loopback host through dialLoopback, without its credential', async () => {
    const res = await viaProxy(`http://localhost:${targetPort}/hello?x=1`, { 'Proxy-Authorization': auth })
    expect(res.status).toBe(200)
    expect(res.body).toBe(`GET /hello?x=1 host=localhost:${targetPort} auth=none`)
    expect(loopbackDials).toEqual([targetPort])
    expect(directDials).toEqual([])
  })

  it('parses CONNECT authorities', () => {
    expect(parseAuthority('[::1]:3000')).toEqual({ host: '::1', port: 3000 })
    expect(parseAuthority('localhost:0')).toBeNull()
  })

  it('requires the per-launch credential', async () => {
    const missing = await viaProxy(`http://localhost:${targetPort}/`)
    expect(missing.status).toBe(407)
    expect(missing.headers['proxy-authenticate']).toMatch(/^Basic/)
    const wrong = await viaProxy(`http://localhost:${targetPort}/`, { 'Proxy-Authorization': 'Basic d3Jvbmc6d3Jvbmc=' })
    expect(wrong.status).toBe(407)
    const tunnel = await connectTunnel(`localhost:${targetPort}`, {})
    expect(tunnel.status).toBe(407)
    tunnel.socket.destroy()
    expect(loopbackDials).toEqual([])
  })

  it('connects non-loopback hosts directly', async () => {
    const res = await viaProxy(`http://example.test:${targetPort}/direct`, { 'Proxy-Authorization': auth })
    expect(res.status).toBe(200)
    expect(res.body).toContain('GET /direct host=example.test')
    // To the address that was checked, not the name again.
    expect(directDials).toEqual([{ host: '93.184.216.34', port: targetPort }])
    expect(loopbackDials).toEqual([])
  })

  it('sends a name that resolves to loopback to the runtime\'s machine', async () => {
    const res = await viaProxy(`http://loopback.test:${targetPort}/x`, { 'Proxy-Authorization': auth })
    expect(res.status).toBe(200)
    expect(loopbackDials).toEqual([targetPort])
    expect(directDials).toEqual([])
  })

  it('refuses the client\'s private ranges to a runtime off its network', async () => {
    reaches = false
    expect((await viaProxy(`http://lan.test:${targetPort}/`, { 'Proxy-Authorization': auth })).status).toBe(403)
    const tunnel = await connectTunnel(`192.168.1.20:${targetPort}`, { 'Proxy-Authorization': auth })
    expect(tunnel.status).toBe(403)
    tunnel.socket.destroy()
    expect(directDials).toEqual([])
    // Loopback still goes to the runtime's machine.
    expect((await viaProxy(`http://127.0.0.1:${targetPort}/`, { 'Proxy-Authorization': auth })).status).toBe(200)
  })

  it('tunnels CONNECT to a normalized loopback target', async () => {
    const { status, socket } = await connectTunnel(`2130706433:${targetPort}`, { 'Proxy-Authorization': auth })
    expect(status).toBe(200)
    socket.destroy()
    expect(loopbackDials).toEqual([targetPort])
    expect(directDials).toEqual([])
  })

  it('tunnels CONNECT to a loopback port', async () => {
    const { status, socket } = await connectTunnel(`localhost:${targetPort}`, { 'Proxy-Authorization': auth })
    expect(status).toBe(200)
    const response = await new Promise<string>((resolve) => {
      let text = ''
      socket.on('data', (chunk) => { text += chunk })
      socket.on('end', () => resolve(text))
      socket.write(`GET /tunnel HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`)
    })
    expect(response).toMatch(/^HTTP\/1\.1 200/)
    expect(response).toContain('GET /tunnel')
    expect(loopbackDials).toEqual([targetPort])
  })

  it('carries a WebSocket over a CONNECT tunnel', async () => {
    const { socket } = await connectTunnel(`localhost:${targetPort}`, { 'Proxy-Authorization': auth })
    const ws = new WebSocket(`ws://localhost:${targetPort}/ws`, { createConnection: () => socket })
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on('open', () => ws.send('hi'))
      ws.on('message', (data) => resolve(String(data)))
      ws.on('error', reject)
    })
    expect(reply).toBe('echo:hi')
    ws.close()
  })

  it('forwards an absolute-URI upgrade to a loopback host', async () => {
    const key = crypto.randomBytes(16).toString('base64')
    const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: proxy.port,
        path: `http://localhost:${targetPort}/ws`,
        headers: {
          'Proxy-Authorization': auth,
          Host: `localhost:${targetPort}`,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
        },
      })
      req.on('upgrade', (response, socket) => {
        socket.destroy()
        resolve(response)
      })
      req.on('response', resolve)
      req.on('error', reject)
      req.end()
    })
    expect(res.statusCode).toBe(101)
    expect(res.headers['sec-websocket-accept']).toBe(accept)
    expect(loopbackDials).toEqual([targetPort])
  })

  it('answers 502 when the loopback port cannot be reached', async () => {
    const closed = await new Promise<number>((resolve) => {
      const server = net.createServer()
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port
        server.close(() => resolve(port))
      })
    })
    const res = await viaProxy(`http://localhost:${closed}/`, { 'Proxy-Authorization': auth })
    expect(res.status).toBe(502)
  })
})

describe('routeFor', () => {
  const deps = (reachesClientNetwork: boolean, upstream = false) => ({ lookup, reachesClientNetwork, upstream })

  it('normalizes hosts as URL parsing does', () => {
    expect(canonicalHost('2130706433')).toBe('127.0.0.1')
    expect(canonicalHost('0x7f.1')).toBe('127.0.0.1')
    expect(canonicalHost('[::ffff:127.0.0.1]')).toBe('::ffff:7f00:1')
    expect(canonicalHost('::1')).toBe('::1')
    expect(canonicalHost('Example.TEST')).toBe('example.test')
    expect(canonicalHost('a b')).toBeNull()
  })

  it('decides loopback on the resolved address', async () => {
    for (const host of ['localhost', '2130706433', '0x7f.1', '::ffff:127.0.0.1', '[::ffff:7f00:1]', 'loopback.test', 'mapped.test', 'mixed.test']) {
      expect(await routeFor(host, deps(false)), host).toEqual({ kind: 'loopback' })
    }
  })

  it('refuses private, link-local and unique local addresses only off the client network', async () => {
    for (const host of ['lan.test', 'ula.test', '10.0.0.1', '169.254.1.1', '[fe80::1]', '::ffff:c0a8:101', '100.64.0.1']) {
      expect(await routeFor(host, deps(false)), host).toEqual({ kind: 'refused' })
      expect((await routeFor(host, deps(true))).kind, host).toBe('direct')
    }
    expect(await routeFor('lan.test', deps(true))).toEqual({ kind: 'direct', host: '192.168.1.20' })
    expect(await routeFor('example.test', deps(false))).toEqual({ kind: 'direct', host: '93.184.216.34' })
  })

  it('applies the same rules with an upstream proxy, which gets the name', async () => {
    expect(await routeFor('lan.test', deps(false, true))).toEqual({ kind: 'refused' })
    expect(await routeFor('loopback.test', deps(false, true))).toEqual({ kind: 'loopback' })
    expect(await routeFor('example.test', deps(false, true))).toEqual({ kind: 'direct', host: 'example.test' })
    // A name only the upstream can resolve goes there; without one it fails.
    expect(await routeFor('intranet.test', deps(false, true))).toEqual({ kind: 'direct', host: 'intranet.test' })
    await expect(routeFor('intranet.test', deps(false))).rejects.toThrow('ENOTFOUND')
  })
})
