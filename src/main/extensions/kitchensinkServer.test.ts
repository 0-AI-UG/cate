// =============================================================================
// Kitchen Sink extension SERVER — full-stack test of the example extension's own
// compiled server (dist/server.js), spawned as a real Node process exactly as
// Cate would (PORT,
// CATE_TOKEN, WORKSPACE_ROOT, CATE_API in the env). We drive every route the
// panel exercises and assert each proves its layer:
//
//   GET  /health             — readiness probe, auth-exempt
//   GET  /api/info           — HTTP tunnel + bearer gate
//   POST /api/echo           — HTTP round-trip
//   GET  /ws                 — WebSocket upgrade + echo (raw RFC6455 frames)
//   POST /api/cate-roundtrip — the server calls BACK into Cate over CATE_API
//
// A tiny stand-in CATE_API server implements storage.set/get so the reverse
// round-trip is asserted for real, including that the server forwards CATE_TOKEN.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import http from 'http'
import net from 'net'
import crypto from 'crypto'
import path from 'path'

const EXT_DIR = path.resolve(__dirname, '../../../cate-extensions/extensions/cate.kitchensink')
const MANIFEST = path.join(EXT_DIR, 'manifest.json')
// cate-extensions is its own repo, present here only as a local checkout (it's
// gitignored, never committed). Gate on the manifest so this file imports even
// when the checkout is absent.
const HAS_EXT = existsSync(MANIFEST)
const TOKEN = 'kitchensink-test-token'
const WORKSPACE_ROOT = '/tmp/kitchensink-ws'

// The server entry the manifest launches, e.g. "node dist/server.js" ->
// "dist/server.js". Derived (not hardcoded) so this works against a JS catalog
// (server.js) or a compiled-TS one (dist/server.js).
function serverEntry(): string {
  if (!HAS_EXT) return 'server.js'
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { server?: { command?: string } }
  const cmd = m.server?.command ?? ''
  return cmd.split(/\s+/).find((t) => t.endsWith('.js')) ?? 'server.js'
}
const SERVER_JS = HAS_EXT ? path.join(EXT_DIR, serverEntry()) : ''

// dist/ is build output (gitignored); compile it on demand for a TS extension
// if a fresh checkout hasn't run cate-extensions/build.sh yet.
function ensureBuilt(): void {
  if (!HAS_EXT || existsSync(SERVER_JS)) return
  if (!existsSync(path.join(EXT_DIR, 'package.json'))) {
    throw new Error(`missing server entry ${SERVER_JS} (run cate-extensions/build.sh)`)
  }
  const repoBin = path.resolve(__dirname, '../../../node_modules/.bin')
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const res = spawnSync(npmCmd, ['run', 'build'], {
    cwd: EXT_DIR,
    env: { ...process.env, PATH: `${repoBin}${path.delimiter}${process.env.PATH ?? ''}` },
    stdio: 'inherit',
  })
  if (res.status !== 0) {
    throw new Error('failed to build the kitchensink extension (run cate-extensions/build.sh)')
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

interface Reply { status: number; text: string; json: unknown }

function httpRequest(
  port: number,
  opts: { method?: string; path: string; token?: string | null; body?: string },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {}
    if (opts.token !== null) headers['Authorization'] = `Bearer ${opts.token ?? TOKEN}`
    if (opts.body != null) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = String(Buffer.byteLength(opts.body))
    }
    const req = http.request(
      { host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json: unknown = null
          try { json = text ? JSON.parse(text) : null } catch { /* non-JSON */ }
          resolve({ status: res.statusCode ?? 0, text, json })
        })
      },
    )
    req.on('error', reject)
    if (opts.body != null) req.write(opts.body)
    req.end()
  })
}

/** Poll /health until it answers 200, or throw after `tries`. */
async function waitForHealth(port: number, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await httpRequest(port, { path: '/health', token: null })
      if (r.status === 200) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('kitchensink server never became healthy')
}

/** Minimal raw WebSocket client: handshake, send one masked text frame, resolve
 *  with the server's decoded (unmasked) echo frame payload. */
function wsEcho(port: number, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64')
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        'GET /ws HTTP/1.1\r\n' +
          'Host: 127.0.0.1\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n' +
          `Authorization: Bearer ${TOKEN}\r\n\r\n`,
      )
    })
    let handshakeDone = false
    const buf: Buffer[] = []
    socket.on('data', (chunk: Buffer) => {
      if (!handshakeDone) {
        const text = chunk.toString('utf8')
        if (!text.includes('101')) { reject(new Error('no 101 upgrade: ' + text.split('\r\n')[0])); socket.destroy(); return }
        handshakeDone = true
        // Send a masked client text frame (clients MUST mask).
        const payload = Buffer.from(message, 'utf8')
        const mask = crypto.randomBytes(4)
        const masked = Buffer.alloc(payload.length)
        for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4]
        const frame = Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked])
        socket.write(frame)
        // The handshake response may carry the echo frame after \r\n\r\n.
        const sep = chunk.indexOf('\r\n\r\n')
        const trailing = sep !== -1 ? chunk.slice(sep + 4) : Buffer.alloc(0)
        if (trailing.length >= 2) buf.push(trailing)
        return
      }
      buf.push(chunk)
    })
    // Decode the first server (unmasked) text frame once enough bytes arrive.
    const timer = setInterval(() => {
      const all = Buffer.concat(buf)
      if (all.length < 2) return
      const len = all[1] & 0x7f
      if (all.length < 2 + len) return
      clearInterval(timer)
      socket.destroy()
      resolve(all.slice(2, 2 + len).toString('utf8'))
    }, 5)
    socket.on('error', reject)
    setTimeout(() => { clearInterval(timer); reject(new Error('ws echo timed out')) }, 2000)
  })
}

describe.skipIf(!HAS_EXT)('Kitchen Sink extension server (spawned)', () => {
  let child: ChildProcess
  let port: number
  let cateApi: http.Server
  let cateApiUrl: string
  const cateApiAuths: string[] = []
  const cateApiStore = new Map<string, unknown>()

  beforeAll(async () => {
    ensureBuilt()
    // Stand up a stand-in CATE_API endpoint backing storage.set/get.
    cateApi = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        cateApiAuths.push(req.headers['authorization'] ?? '')
        if (req.headers['authorization'] !== `Bearer ${TOKEN}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return
        }
        let body: { method?: string; args?: { key?: string; value?: unknown } } = {}
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* keep {} */ }
        let result: unknown = { error: 'unsupported' }
        if (body.method === 'cate.storage.set') { cateApiStore.set(String(body.args?.key), body.args?.value); result = { ok: true } }
        else if (body.method === 'cate.storage.get') { result = cateApiStore.get(String(body.args?.key)) }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result }))
      })
    })
    const apiPort = await freePort()
    await new Promise<void>((resolve) => cateApi.listen(apiPort, '127.0.0.1', resolve))
    cateApiUrl = `http://127.0.0.1:${apiPort}`

    port = await freePort()
    child = spawn(process.execPath, [SERVER_JS], {
      env: { ...process.env, PORT: String(port), CATE_TOKEN: TOKEN, WORKSPACE_ROOT, CATE_API: cateApiUrl },
      stdio: 'ignore',
    })
    await waitForHealth(port)
  }, 60_000)

  afterAll(async () => {
    if (child && !child.killed) child.kill('SIGKILL')
    await new Promise<void>((resolve) => cateApi.close(() => resolve()))
  })

  it('serves /health without a token (the readiness probe)', async () => {
    const r = await httpRequest(port, { path: '/health', token: null })
    expect(r.status).toBe(200)
    expect(r.text).toBe('ok')
  })

  it('401s a non-health route with no bearer token', async () => {
    const r = await httpRequest(port, { path: '/api/info', token: null })
    expect(r.status).toBe(401)
  })

  it('serves /api/info with the workspace root over the HTTP tunnel', async () => {
    const r = await httpRequest(port, { path: '/api/info' })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ workspaceRoot: WORKSPACE_ROOT, cateApiConfigured: true })
    expect((r.json as { pid: number }).pid).toBeGreaterThan(0)
  })

  it('echoes a POST body back from /api/echo', async () => {
    const payload = { hello: 'from the page', n: 7 }
    const r = await httpRequest(port, { method: 'POST', path: '/api/echo', body: JSON.stringify(payload) })
    expect(r.status).toBe(200)
    expect((r.json as { echoed: unknown }).echoed).toEqual(payload)
  })

  it('echoes a WebSocket text frame back over the upgrade tunnel', async () => {
    const echo = await wsEcho(port, 'ping-123')
    expect(echo).toBe('echo: ping-123')
  })

  it('round-trips through CATE_API, forwarding CATE_TOKEN on the reverse call', async () => {
    const r = await httpRequest(port, { method: 'POST', path: '/api/cate-roundtrip', body: '' })
    expect(r.status).toBe(200)
    const body = r.json as { ok: boolean; wrote: string; read: unknown }
    expect(body.ok).toBe(true)
    expect(body.read).toBe(body.wrote)
    // The server set then got the same key through our stand-in CATE_API...
    expect(cateApiStore.get('kitchensink:roundtrip')).toBe(body.wrote)
    // ...authenticating every reverse call with the injected bearer token.
    expect(cateApiAuths.length).toBeGreaterThanOrEqual(2)
    expect(cateApiAuths.every((a) => a === `Bearer ${TOKEN}`)).toBe(true)
  })

  it('404s an unknown authenticated route', async () => {
    const r = await httpRequest(port, { path: '/api/nope' })
    expect(r.status).toBe(404)
  })
})
