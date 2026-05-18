// =============================================================================
// Orchestrator socket server — accepts connections from the `cate` CLI over
// a Unix domain socket and dispatches commands to handlers.
//
// Protocol: line-delimited JSON. Client sends one OrchRequest per line; server
// replies with one OrchResponse per line. Connection stays open for the duration
// of a single command (commands that stream — e.g. `ask` in Phase C — may emit
// multiple frames before the final response).
// =============================================================================

import net from 'net'
import fs from 'fs'
import os from 'os'
import path from 'path'
import log from '../logger'
import type { OrchRequest, OrchResponse } from './protocol'
import { handleCommand } from './commands'

let server: net.Server | null = null
let socketPath = ''

export function getSocketPath(): string {
  return socketPath
}

export function ensureSocketDir(): string {
  const dir = path.join(os.homedir(), '.cate')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export async function startSocketServer(): Promise<void> {
  if (server) return
  const dir = ensureSocketDir()
  socketPath = path.join(dir, 'cate.sock')

  // Remove a stale socket from a previous crash. On Linux/macOS a leftover
  // socket file blocks bind with EADDRINUSE.
  try {
    const stat = fs.statSync(socketPath)
    if (stat.isSocket() || stat.isFIFO()) fs.unlinkSync(socketPath)
  } catch {
    /* not present, nothing to clean up */
  }

  server = net.createServer((conn) => {
    let buf = ''
    conn.setEncoding('utf8')

    const reply = (resp: OrchResponse) => {
      try {
        conn.write(JSON.stringify(resp) + '\n')
      } catch (e: any) {
        log.warn('Orchestrator: failed to write response: %s', e?.message ?? e)
      }
    }

    conn.on('data', (data: string) => {
      buf += data
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (!line.trim()) continue
        let req: OrchRequest
        try {
          req = JSON.parse(line) as OrchRequest
        } catch {
          reply({ id: 0, ok: false, error: 'invalid JSON request', code: 'BAD_REQUEST' })
          continue
        }
        // Run command async; multiple commands per connection are sequenced
        // by JS event loop ordering (sufficient for the CLI usage pattern).
        handleCommand(req, reply).catch((e: any) => {
          reply({ id: req.id, ok: false, error: e?.message ?? String(e), code: 'INTERNAL' })
        })
      }
    })

    conn.on('error', (e: any) => {
      log.warn('Orchestrator: connection error: %s', e?.message ?? e)
    })
  })

  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(socketPath, () => {
      try { fs.chmodSync(socketPath, 0o600) } catch { /* best effort */ }
      log.info('Orchestrator: listening on %s', socketPath)
      resolve()
    })
  })
}

export async function stopSocketServer(): Promise<void> {
  const s = server
  if (!s) return
  server = null
  await new Promise<void>((resolve) => {
    s.close(() => resolve())
  })
  try { fs.unlinkSync(socketPath) } catch { /* already gone */ }
}
