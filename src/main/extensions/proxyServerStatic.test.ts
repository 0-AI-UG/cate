// =============================================================================
// proxyServer (frontend-only serving) — the static half of the extension proxy,
// the path the `cate.frontendkit` demo rides. A frontend-only extension has NO
// server: the proxy serves its files straight from the installed root dir. We
// stand up the real proxy http.Server, point it at the REAL cate.frontendkit
// extension dir, and assert:
//
//   - GET /ext/<token>/            serves index.html with the guest CSP
//   - GET /ext/<token>/app.js      serves the script with a JS content-type
//   - path traversal (../) is refused (403)
//   - a disabled extension is refused (403) and an unknown route 404s
//
// The server-backed reverse-proxy path is covered by kitchensinkServer.test.ts;
// here only ExtensionManager is faked (no tunnel/server machinery is touched).
// =============================================================================

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import http from 'http'
import path from 'path'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'

const EXT_DIR = path.resolve(__dirname, '../../../cate-extensions/extensions/cate.frontendkit')
// cate-extensions is a local checkout (gitignored); skip when it's absent so a
// bare clone stays green.
const HAS_EXT = existsSync(path.join(EXT_DIR, 'manifest.json'))

const EXT_ID = 'cate.frontendkit'
const WS = 'ws-1'

// ExtensionManager is the only collaborator the frontend-only path uses. The
// other top-level imports (server manager, tunnel) are stubbed so importing
// proxyServer doesn't drag in the daemon machinery.
const state = vi.hoisted(() => ({ enabled: true }))
vi.mock('./ExtensionManager', () => ({
  extensionManager: {
    isKnown: (id: string) => id === EXT_ID,
    isEnabled: () => state.enabled,
    getManifest: () => ({
      id: EXT_ID,
      name: 'Frontend Kit',
      frontend: 'index.html',
      panels: [{ id: 'main', label: 'Frontend Kit' }],
    }),
    // Provisioning now returns the host root dir; the LOCAL host shares the fs,
    // so it's the on-disk extension dir read through the runtime below.
    ensureProvisioned: async () => EXT_DIR,
  },
}))
vi.mock('./ExtensionServerManager', () => ({ extensionServerManager: {} }))
vi.mock('./serverTunnel', () => ({ openTunnelDuplex: vi.fn() }))
vi.mock('../logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('electron', () => ({}))
// Static assets are now read through the workspace's runtime. Resolve LOCAL to a
// fake runtime whose file.readBinary reads straight off disk (LOCAL == host).
vi.mock('../workspaceManager', () => ({ getWorkspaceInfo: () => ({ rootPath: EXT_DIR }) }))
vi.mock('../runtime/runtimeManager', () => ({
  runtimes: { resolve: () => ({ id: 'local', file: { readBinary: (p: string) => readFile(p) } }) },
}))

import { ensureProxyServer, getProxyUrlFor } from './proxyServer'

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

/** Raw GET against the proxy at an exact (already-encoded) path — no client-side
 *  normalization, so a traversal payload reaches the server as written. */
function get(port: number, rawPath: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: rawPath }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      )
    })
    req.on('error', reject)
    req.end()
  })
}

describe.skipIf(!HAS_EXT)('proxyServer — frontend-only static serving (cate.frontendkit)', () => {
  let port: number
  let token: string
  let base: string

  beforeAll(async () => {
    port = await ensureProxyServer()
    // Resolve a URL for the frontend-only panel: with no `sender`, this skips the
    // server-join path entirely and just registers a route + returns the URL.
    const resolved = await getProxyUrlFor({ extensionId: EXT_ID, workspaceId: WS, panelId: 'main' })
    expect(resolved && 'url' in resolved).toBe(true)
    base = (resolved as { url: string }).url
    token = /\/ext\/([^/]+)\//.exec(base)![1]
  })

  afterEach(() => {
    state.enabled = true
  })

  it('serves index.html (the frontend entry) with the guest CSP', async () => {
    const r = await get(port, `/ext/${token}/`)
    expect(r.status).toBe(200)
    expect(String(r.headers['content-type'])).toContain('text/html')
    expect(String(r.headers['content-security-policy'])).toContain("script-src 'self'")
    expect(r.body).toContain('Frontend Kit')
    expect(r.body).toContain('app.js')
  })

  it('serves the panel script with a javascript content-type', async () => {
    const r = await get(port, `/ext/${token}/app.js`)
    expect(r.status).toBe(200)
    expect(String(r.headers['content-type'])).toContain('javascript')
    expect(r.body).toContain('window.cate')
  })

  it('refuses path traversal out of the extension root (403)', async () => {
    const r = await get(port, `/ext/${token}/..%2f..%2f..%2fpackage.json`)
    expect(r.status).toBe(403)
  })

  it('refuses backslash-delimited traversal (Windows-separator payload) (403)', async () => {
    // %5c is a backslash: decoded to '..\..\..\package.json' this is ONE segment
    // (split is on '/'), so a bare '..'-only check misses it. The host-native
    // join (path.win32 on Windows) would treat the backslashes as separators and
    // escape rootDir — the separator-in-segment check must reject it.
    const r = await get(port, `/ext/${token}/..%5c..%5c..%5cpackage.json`)
    expect(r.status).toBe(403)
  })

  it('404s an unknown route token', async () => {
    const r = await get(port, `/ext/deadbeefdeadbeef/index.html`)
    expect(r.status).toBe(404)
  })

  it('refuses to serve when the extension is disabled (403)', async () => {
    state.enabled = false
    const r = await get(port, `/ext/${token}/`)
    expect(r.status).toBe(403)
  })
})
