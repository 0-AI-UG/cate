// =============================================================================
// Extension proxy server — one lazily-started Node http.Server bound to
// 127.0.0.1:0 that serves an enabled extension's panel.
//
// Routing is via an opaque per-(extensionId, workspaceId) routeToken so a
// relative asset request carries BOTH ids without re-parsing the query on every
// hit:
//
//   GET /ext/<routeToken>/             -> frontend entry html OR proxied server '/'
//   GET /ext/<routeToken>/<rel-path>   -> static asset OR proxied server path
//
// Two backends share this surface:
//   - FRONTEND-ONLY (manifest.frontend, no server): static files under the
//     extension's root dir, with path-traversal protection (Phase 1 behavior).
//   - SERVER-BACKED (manifest.server): every request (and WebSocket upgrade) is
//     reverse-proxied to the extension's own HTTP server, which runs on the
//     workspace's runtime host and is reached ONLY over a tunnel Duplex (3A).
//     The CATE_TOKEN bearer is injected here so the webview never holds it.
// =============================================================================

import http from 'http'
import path from 'path'
import { randomBytes } from 'crypto'
import type { Duplex } from 'stream'
import { fileURLToPath } from 'url'
import log from '../logger'
import { extensionManager } from './ExtensionManager'
import { extensionServerManager } from './ExtensionServerManager'
import { openTunnelDuplex } from './serverTunnel'
import { parseLocator, LOCAL_RUNTIME_ID } from '../runtime/locator'
import { runtimes } from '../runtime/runtimeManager'
import { hostJoin } from '../../agent/main/agentDir'
import { getWorkspaceInfo } from '../workspaceManager'
import type { Runtime } from '../runtime/types'
import type { ExtensionManifest } from '../../shared/extensions'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
}

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

let server: http.Server | null = null
let startPromise: Promise<number> | null = null

// ---------------------------------------------------------------------------
// Route registry — a stable opaque token per (extensionId, workspaceId), so the
// path itself identifies the route (relative assets keep working) without
// leaking ids into the URL beyond an opaque handle.
// ---------------------------------------------------------------------------

interface Route {
  extensionId: string
  workspaceId: string
}

const routesByToken = new Map<string, Route>()
const tokenByPair = new Map<string, string>() // `${extensionId} ${workspaceId}` -> routeToken

function registerRoute(extensionId: string, workspaceId: string): string {
  const pair = `${extensionId} ${workspaceId}`
  const existing = tokenByPair.get(pair)
  if (existing) return existing
  const token = randomBytes(12).toString('hex')
  routesByToken.set(token, { extensionId, workspaceId })
  tokenByPair.set(pair, token)
  return token
}

/**
 * Resolve the AUTHORITATIVE (extensionId, workspaceId) for a guest webview from
 * its current URL. The proxy assigns the opaque routeToken in the path
 * (`/ext/<routeToken>/`) per (extensionId, workspaceId), so a guest can't forge
 * another extension's identity without knowing its random token — this is the
 * trusted source of identity, NOT the client-supplied query string the preload
 * forwards. The panelId in the query stays client-supplied (validated elsewhere).
 * Returns null when the URL isn't a known extension-proxy route.
 */
export function identityForGuestUrl(
  rawUrl: string,
): { extensionId: string; workspaceId: string } | null {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(rawUrl)
  } catch {
    return null
  }
  // Security: the routeToken alone is not enough — a guest that navigates to
  // `https://attacker.com/ext/<validToken>/…` would otherwise resolve to the
  // extension's identity and get the full cate.* API. Only a URL served by THIS
  // proxy's own origin (127.0.0.1:<port>) is a trusted route.
  const origin = getProxyOrigin()
  if (!origin || parsedUrl.origin !== origin) return null
  const parsed = parseExtPath(parsedUrl.pathname)
  if (!parsed) return null
  const route = routesByToken.get(parsed.token)
  return route ? { extensionId: route.extensionId, workspaceId: route.workspaceId } : null
}

/** The frontend entry (relative) for an extension, defaulting to index.html. */
function frontendEntry(manifest: ExtensionManifest): string {
  return manifest.frontend && manifest.frontend.length > 0 ? manifest.frontend : 'index.html'
}

/**
 * Resolve a request's relative URL path to a host-absolute file inside `rootDir`,
 * or null if it would escape the root (path traversal → 403). The asset lives on
 * the workspace's runtime host, so join with the host's separator (native for
 * LOCAL — client == host — posix for remote daemons). The decoded URL path is
 * always posix; any absolute path or `..` segment is refused outright (rather
 * than silently collapsed) so a traversal attempt is a clear rejection.
 */
function resolveAssetPath(runtime: Runtime, rootDir: string, relPath: string): string | null {
  const decoded = decodeURIComponent(relPath)
  if (path.posix.isAbsolute(decoded)) return null
  const segments = decoded.split('/').filter((s) => s !== '' && s !== '.')
  if (segments.length === 0) return null
  // Reject a `..` segment OR any segment carrying a native separator ('\\' or
  // '/'): the LOCAL runtime joins with the host's native separator (path.win32
  // on Windows), so a backslash-delimited segment like '..\\..\\secret' is ONE
  // non-'..' segment that would otherwise escape rootDir on a Windows host.
  if (segments.some((s) => s === '..' || s.includes('\\') || s.includes('/'))) return null
  const abs = hostJoin(runtime.id, rootDir, ...segments)
  // Final containment re-check with the host's path flavor (native for LOCAL,
  // posix for remote): the normalized join must stay inside rootDir — equal to
  // it, or under it followed by the separator.
  const p = runtime.id === LOCAL_RUNTIME_ID ? path : path.posix
  const normRoot = p.normalize(rootDir)
  const normAbs = p.normalize(abs)
  const rootWithSep = normRoot.endsWith(p.sep) ? normRoot : normRoot + p.sep
  if (normAbs !== normRoot && !normAbs.startsWith(rootWithSep)) return null
  return abs
}

// Immutable-per-version asset cache, keyed by `<hostRootDir>\0<relPath>`. The
// host root dir embeds the extension version (~/.cate/extensions/<id>/<version>),
// so a version bump yields a fresh key and the stale entries simply age out.
// Bounded by entry count (assets are served from a remote host over base64 RPC,
// so caching avoids a round-trip per request); oldest-inserted evicted on overflow.
const ASSET_CACHE_MAX = 512
const assetCache = new Map<string, Buffer>()

function cacheGet(key: string): Buffer | undefined {
  return assetCache.get(key)
}

function cachePut(key: string, data: Buffer): void {
  if (assetCache.size >= ASSET_CACHE_MAX) {
    const oldest = assetCache.keys().next().value
    if (oldest !== undefined) assetCache.delete(oldest)
  }
  assetCache.set(key, data)
}

/** Drop all cached static assets. Called when an extension's bytes change
 *  (reinstall/update) so a same-version repair doesn't keep serving stale bytes. */
export function clearStaticAssetCache(): void {
  assetCache.clear()
}

/** Parse `/ext/<routeToken>/<tail>` -> { token, tail } (tail has no leading /). */
function parseExtPath(pathname: string): { token: string; tail: string } | null {
  const match = /^\/ext\/([^/]+)\/(.*)$/.exec(pathname)
  if (!match) return null
  return { token: decodeURIComponent(match[1]), tail: match[2] }
}

// ---------------------------------------------------------------------------
// Static (frontend-only) serving
// ---------------------------------------------------------------------------

async function serveStatic(
  res: http.ServerResponse,
  extensionId: string,
  workspaceId: string,
  manifest: ExtensionManifest,
  tail: string,
): Promise<void> {
  // Resolve the workspace's runtime, provision the extension onto that host, and
  // read assets through runtime.file — so a remote workspace's panel is served
  // from the remote host, with no isLocal branch (LOCAL is just another daemon).
  const { runtimeId } = parseLocator(getWorkspaceInfo(workspaceId)?.rootPath ?? '')
  let runtime: Runtime
  try {
    runtime = runtimes.resolve(runtimeId)
  } catch {
    res.writeHead(404).end('Runtime not connected')
    return
  }

  let rootDir: string
  try {
    rootDir = await extensionManager.ensureProvisioned(extensionId, runtime)
  } catch (err) {
    log.warn('[extensions] provision for static serve failed %s: %O', extensionId, err)
    res.writeHead(404).end('Extension not available')
    return
  }

  const relPath = tail.length === 0 ? frontendEntry(manifest) : tail
  const abs = resolveAssetPath(runtime, rootDir, relPath)
  if (!abs) {
    res.writeHead(403).end('Forbidden')
    return
  }
  const cacheKey = `${rootDir}\0${abs}`
  let data: Buffer | undefined = cacheGet(cacheKey)
  if (!data) {
    try {
      data = await runtime.file.readBinary(abs)
    } catch {
      res.writeHead(404).end('Not found')
      return
    }
    cachePut(cacheKey, data)
  }
  const headers: http.OutgoingHttpHeaders = {
    'Content-Type': contentTypeFor(abs),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }
  if (path.extname(abs).toLowerCase() === '.html') {
    headers['Content-Security-Policy'] =
      "default-src 'self'; " +
      "script-src 'self'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; " +
      "font-src 'self' data:; " +
      "connect-src 'self'; " +
      "frame-ancestors *"
  }
  res.writeHead(200, headers)
  res.end(data)
}

// ---------------------------------------------------------------------------
// Server-backed reverse proxy (HTTP) — forward over the tunnel Duplex with the
// CATE_TOKEN bearer injected.
// ---------------------------------------------------------------------------

async function proxyHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  extensionId: string,
  workspaceId: string,
  tail: string,
): Promise<void> {
  const { runtime, port, token } = await extensionServerManager.ensureServer(extensionId, workspaceId)
  const duplex = await openTunnelDuplex(runtime, port)
  // Strip the /ext/<routeToken> prefix; the upstream server sees a root-relative
  // path. Preserve the query string.
  const queryIdx = (req.url ?? '').indexOf('?')
  const query = queryIdx >= 0 ? (req.url ?? '').slice(queryIdx) : ''
  const upstreamPath = '/' + tail + query

  const upstream = http.request(
    {
      createConnection: () => duplex as unknown as import('net').Socket,
      host: '127.0.0.1',
      port,
      method: req.method,
      path: upstreamPath,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${port}`,
        authorization: `Bearer ${token}`,
      },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    },
  )
  upstream.on('error', (err) => {
    log.warn('[extensions] upstream proxy error %s: %O', extensionId, err)
    try { res.writeHead(502).end('Bad gateway') } catch { /* already sent */ }
    try { duplex.destroy() } catch { /* noop */ }
  })
  req.on('aborted', () => { try { upstream.destroy() } catch { /* noop */ } })
  // Tear the tunnel Duplex down when the response finishes (or the client goes
  // away) — otherwise a keep-alive upstream leaves the Duplex, the tunnel connId,
  // and the daemon-side loopback socket leaked once per request.
  res.on('close', () => { try { duplex.destroy() } catch { /* noop */ } })
  req.pipe(upstream)
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const parsed = parseExtPath(url.pathname)
  if (!parsed) {
    res.writeHead(404).end('Not found')
    return
  }
  const route = routesByToken.get(parsed.token)
  if (!route) {
    res.writeHead(404).end('Unknown route')
    return
  }
  const { extensionId, workspaceId } = route
  if (!extensionManager.isKnown(extensionId) || !extensionManager.isEnabled(extensionId)) {
    res.writeHead(403).end('Extension not enabled')
    return
  }
  const manifest = extensionManager.getManifest(extensionId)
  if (!manifest) {
    res.writeHead(404).end('Extension not found')
    return
  }

  if (manifest.server) {
    await proxyHttp(req, res, extensionId, workspaceId, parsed.tail)
    return
  }
  await serveStatic(res, extensionId, workspaceId, manifest, parsed.tail)
}

// ---------------------------------------------------------------------------
// WebSocket upgrade — raw pipe over the tunnel for server-backed routes.
// ---------------------------------------------------------------------------

async function handleUpgrade(
  req: http.IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const parsed = parseExtPath(url.pathname)
  if (!parsed) { clientSocket.destroy(); return }
  const route = routesByToken.get(parsed.token)
  if (!route) { clientSocket.destroy(); return }
  const { extensionId, workspaceId } = route
  const manifest = extensionManager.getManifest(extensionId)
  if (
    !manifest?.server ||
    !extensionManager.isKnown(extensionId) ||
    !extensionManager.isEnabled(extensionId)
  ) {
    clientSocket.destroy()
    return
  }

  let upstream: Duplex
  let token: string
  let port: number
  try {
    const ep = await extensionServerManager.ensureServer(extensionId, workspaceId)
    token = ep.token
    port = ep.port
    upstream = await openTunnelDuplex(ep.runtime, port)
  } catch (err) {
    log.warn('[extensions] ws upstream open failed %s: %O', extensionId, err)
    clientSocket.destroy()
    return
  }

  // Re-serialize the upgrade request with the prefix-stripped path + the
  // injected auth/host headers, then pipe both directions raw (don't parse WS
  // frames). The upstream server completes the handshake.
  const queryIdx = (req.url ?? '').indexOf('?')
  const query = queryIdx >= 0 ? (req.url ?? '').slice(queryIdx) : ''
  const upstreamPath = '/' + parsed.tail + query
  const headers: Record<string, string> = {}
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    headers[req.rawHeaders[i].toLowerCase()] = req.rawHeaders[i + 1]
  }
  headers['host'] = `127.0.0.1:${port}`
  headers['authorization'] = `Bearer ${token}`

  const lines = [`${req.method} ${upstreamPath} HTTP/1.1`]
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`)
  lines.push('', '')
  upstream.write(lines.join('\r\n'))
  if (head && head.length > 0) upstream.write(head)

  const teardown = (): void => {
    try { clientSocket.destroy() } catch { /* noop */ }
    try { upstream.destroy() } catch { /* noop */ }
  }
  clientSocket.on('error', teardown)
  upstream.on('error', teardown)
  clientSocket.on('close', teardown)
  upstream.on('close', teardown)
  upstream.pipe(clientSocket)
  clientSocket.pipe(upstream)
}

/** Start the proxy server if it isn't running. Returns the bound port. */
export async function ensureProxyServer(): Promise<number> {
  if (server) {
    const addr = server.address()
    if (addr && typeof addr === 'object') return addr.port
  }
  if (startPromise) return startPromise
  startPromise = new Promise<number>((resolve, reject) => {
    const s = http.createServer((req, res) => {
      handleRequest(req, res).catch((err) => {
        log.warn('[extensions] proxy request failed: %O', err)
        try { res.writeHead(500).end('Internal error') } catch { /* already sent */ }
      })
    })
    s.on('upgrade', (req, socket, head) => {
      handleUpgrade(req, socket as Duplex, head).catch((err) => {
        log.warn('[extensions] proxy upgrade failed: %O', err)
        try { (socket as Duplex).destroy() } catch { /* noop */ }
      })
    })
    s.on('error', (err) => {
      // Clear the cached promise so a later call retries rather than replaying
      // this same rejection forever.
      startPromise = null
      reject(err)
    })
    s.listen(0, '127.0.0.1', () => {
      server = s
      const addr = s.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      log.info('[extensions] proxy listening on 127.0.0.1:%d', port)
      resolve(port)
    })
  })
  return startPromise
}

/**
 * Absolute path to the BUILT cateHost preload. electron-vite emits preload
 * bundles to `dist/preload/`, and the main bundle runs from `dist/main/`, so
 * the main preload is loaded as `<__dirname>/../preload/index.js`
 * (see windowFactory). cateHost ships alongside it as `cateHost.js`.
 */
export function getCateHostPreloadPath(): string {
  const base =
    typeof __dirname !== 'undefined'
      ? __dirname
      : path.dirname(fileURLToPath(import.meta.url))
  return path.join(base, '../preload/cateHost.js')
}

/**
 * Resolve the webview URL + preload path for one (extensionId, workspaceId,
 * panelId). Returns null if the extension is unknown or not enabled. For a
 * server-backed extension this joins the panel + ensures the server is READY
 * (awaiting spawn), so the URL is only returned once the server is up — and a
 * spawn/ready failure surfaces as `{ error }` for the panel to render.
 */
export async function getProxyUrlFor(args: {
  extensionId: string
  workspaceId: string
  panelId: string
  sender?: Electron.WebContents
}): Promise<{ url: string; preloadPath: string } | { error: string } | null> {
  const { extensionId, workspaceId, panelId, sender } = args
  if (!extensionManager.isKnown(extensionId) || !extensionManager.isEnabled(extensionId)) {
    return null
  }
  const manifest = extensionManager.getManifest(extensionId)
  if (!manifest) return null

  // URL-BACKED (manifest.url, no server): the panel points straight at a remote
  // https page — no proxy server, no route token, no spawned process. Mode
  // precedence is server > url > frontend, so this is only taken when the
  // manifest declares no server.
  //
  // Security: such a guest gets NO cate host API. Guest identity is derived from
  // the proxy's own origin + opaque routeToken (identityForGuestUrl), which a
  // remote origin can never satisfy; handing it the cateHost preload would only
  // create a bridge whose every call is rejected, while widening the surface a
  // third-party page can poke at. So we return an empty preloadPath (the panel
  // then omits the attribute) — and webSecurity.ts independently strips the
  // preload from any guest whose URL isn't the proxy origin, so this holds even
  // if the renderer asked for one.
  if (!manifest.server && manifest.url) {
    return { url: manifest.url, preloadPath: '' }
  }

  const port = await ensureProxyServer()
  const routeToken = registerRoute(extensionId, workspaceId)

  // Server-backed: join the panel (registers the owner + cancels grace) and
  // ensure the server is READY before handing back the URL.
  if (manifest.server && sender) {
    try {
      await extensionServerManager.joinPanel(extensionId, workspaceId, panelId, sender)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  const query =
    `cateExt=${encodeURIComponent(extensionId)}` +
    `&cateWs=${encodeURIComponent(workspaceId)}` +
    `&catePanel=${encodeURIComponent(panelId)}`
  const url = `http://127.0.0.1:${port}/ext/${routeToken}/?${query}`
  return { url, preloadPath: getCateHostPreloadPath() }
}

/** The proxy origin (scheme + host + port), or null if not started yet. Used to
 *  scope the guest CSP in webSecurity. */
export function getProxyOrigin(): string | null {
  if (!server) return null
  const addr = server.address()
  if (!addr || typeof addr !== 'object') return null
  return `http://127.0.0.1:${addr.port}`
}
