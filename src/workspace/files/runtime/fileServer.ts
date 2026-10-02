// Serves workspace files over HTTP on a loopback port of the runtime's
// machine, so a browser panel shows a workspace file (and resolves its
// relative links) the same way on every client: the webview reaches the port
// through loopback routing (12.3). Bound to 127.0.0.1; every URL starts with
// a random per-start token, and every path goes through the path scope.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'

export interface FileServer {
  /** The URL serving `absPath` (started on first use). */
  urlFor(absPath: string): Promise<string>
  close(): Promise<void>
}

export interface FileServerDeps {
  /** The path scope's strict check: the real path, or a throw. */
  strict(p: string): Promise<string>
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
  const token = randomBytes(24).toString('hex')
  let started: Promise<{ server: http.Server; port: number }> | null = null

  const respond = (res: http.ServerResponse, status: number, message: string): void => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(message)
  }

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return respond(res, 405, 'Method not allowed')
    const pathname = (req.url ?? '/').split(/[?#]/)[0]
    const prefix = `/${token}/`
    if (!pathname.startsWith(prefix)) return respond(res, 404, 'Not found')
    const requested = decodeServedPath(pathname.slice(prefix.length))
    if (!requested) return respond(res, 400, 'Bad path')
    let file: string
    try {
      file = await deps.strict(path.resolve(requested))
      let stat = await fs.promises.stat(file)
      if (stat.isDirectory()) {
        file = await deps.strict(path.join(file, 'index.html'))
        stat = await fs.promises.stat(file)
      }
      if (!stat.isFile()) return respond(res, 404, 'Not found')
      res.writeHead(200, {
        'Content-Type': contentTypeOf(file),
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
      const { port } = await start()
      return `http://127.0.0.1:${port}/${token}/${encodeServedPath(safe)}`
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
