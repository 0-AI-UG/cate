// Serves workspace files over HTTP on a loopback port of the runtime's
// machine, so a browser panel shows a workspace file (and resolves its
// relative links) the same way on every client: the webview reaches the port
// through loopback routing (12.3). Bound to 127.0.0.1; every URL starts with
// a random token bound to the served file's folder, so a page reaches only
// that folder (its relative links), and every path goes through the path
// scope. While the workspace is untrusted, pages that could run script are
// served as plain text (9.2).

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { pathHasPrefix, pathKey } from '../contract'

export interface FileServer {
  /** The URL serving `absPath` (started on first use). */
  urlFor(absPath: string): Promise<string>
  /** The workspace path a URL of this server serves, or null. */
  pathOf(url: string): string | null
  close(): Promise<void>
}

export interface FileServerDeps {
  /** The path scope's strict check: the real path, or a throw. */
  strict(p: string): Promise<string>
  /** Read per request: untrusted workspaces get no script-running pages. */
  isTrusted(): boolean
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
}

export function contentTypeOf(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/** Types a browser renders as a document that can run script. */
const ACTIVE_TYPE = /^(text\/html|application\/xhtml\+xml|application\/xml|image\/svg\+xml)\b/

/** `/Users/a/b c.html` -> `Users/a/b%20c.html`; `C:\a\b.html` -> `C:/a/b.html`. */
export function encodeServedPath(absPath: string): string {
  return absPath.replace(/\\/g, '/').replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')
}

/** The inverse of `encodeServedPath`, from the URL path after the token. */
export function decodeServedPath(rest: string): string | null {
  try {
    const joined = rest.split('/').map(decodeURIComponent).join('/')
    if (joined.includes('\0')) return null
    return /^[A-Za-z]:\//.test(joined) ? joined : `/${joined}`
  } catch {
    return null
  }
}

export function createFileServer(deps: FileServerDeps): FileServer {
  // One token per served folder; a token reaches only its folder.
  const scopes = new Map<string, string>() // token -> real folder
  const tokens = new Map<string, string>() // pathKey(folder) -> token
  let started: Promise<{ server: http.Server; port: number }> | null = null

  const respond = (res: http.ServerResponse, status: number, message: string): void => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(message)
  }

  const inScope = (p: string, scope: string) => pathHasPrefix(pathKey(p), pathKey(scope))

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return respond(res, 405, 'Method not allowed')
    const pathname = (req.url ?? '/').split(/[?#]/)[0]
    const match = /^\/([0-9a-f]+)\/(.*)$/.exec(pathname)
    const scope = match ? scopes.get(match[1]) : undefined
    if (!match || !scope) return respond(res, 404, 'Not found')
    const requested = decodeServedPath(match[2])
    if (!requested) return respond(res, 400, 'Bad path')
    // Outside the token's folder, before and after symlinks resolve.
    if (!inScope(path.resolve(requested), scope)) return respond(res, 404, 'Not found')
    let file: string
    try {
      file = await deps.strict(path.resolve(requested))
      let stat = await fs.promises.stat(file)
      if (stat.isDirectory()) {
        file = await deps.strict(path.join(file, 'index.html'))
        stat = await fs.promises.stat(file)
      }
      if (!stat.isFile() || !inScope(file, scope)) return respond(res, 404, 'Not found')
      const type = contentTypeOf(file)
      res.writeHead(200, {
        'Content-Type': !deps.isTrusted() && ACTIVE_TYPE.test(type) ? 'text/plain; charset=utf-8' : type,
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      return respond(res, code === 'ENOENT' || code === 'ENOTDIR' ? 404 : 403, code === 'ENOENT' ? 'Not found' : 'Forbidden')
    }
    if (req.method === 'HEAD') return void res.end()
    const stream = fs.createReadStream(file)
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  }

  const start = () => (started ??= new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => { void handle(req, res).catch(() => res.destroy()) })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve({ server, port: (server.address() as AddressInfo).port })
    })
  }))

  return {
    async urlFor(absPath) {
      const safe = await deps.strict(absPath)
      const folder = (await fs.promises.stat(safe)).isDirectory() ? safe : path.dirname(safe)
      let token = tokens.get(pathKey(folder))
      if (!token) {
        token = randomBytes(24).toString('hex')
        tokens.set(pathKey(folder), token)
        scopes.set(token, folder)
      }
      const { port } = await start()
      return `http://127.0.0.1:${port}/${token}/${encodeServedPath(safe)}`
    },
    pathOf(url) {
      const match = /^http:\/\/127\.0\.0\.1:\d+\/([0-9a-f]+)\/([^?#]*)/.exec(url)
      const scope = match ? scopes.get(match[1]) : undefined
      const served = match && scope ? decodeServedPath(match[2]) : null
      return served && inScope(path.resolve(served), scope!) ? served : null
    },
    async close() {
      if (!started) return
      const { server } = await started.catch(() => ({ server: null }))
      started = null
      if (!server) return
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
