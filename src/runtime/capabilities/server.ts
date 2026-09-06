// =============================================================================
// Server capability — electron-free runner for long-lived HTTP server children
// (provider harnesses). Spawns a child with
// PIPED stdio, streams stdout/stderr verbatim, and reports error vs close. The
// extra job here is port management + a readiness probe: it allocates a loopback
// port, injects it via env[portEnv], spawns the server, then polls an HTTP ready
// path and resolves the handle ONLY once the server answers (or rejects on
// timeout / early exit). The tunnel capability then bridges raw TCP to that port.
//
// Nothing electron is imported here, so the SAME code runs locally (Electron-as-
// node) and inside the standalone daemon (the bundled node).
// =============================================================================

import { spawn, type ChildProcess } from 'child_process'
import net from 'net'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  RUNTIME_INSTALL_ROOT_PLACEHOLDER,
  RUNTIME_NODE_EXECUTABLE,
  type ServerHost,
  type ServerStartOptions,
  type ServerHandle,
} from '../../main/runtime/types'
import { installRoot } from '../installRoot'
import { catePathEnv } from '../cateCli'

export interface ServerDeps {
  /** Base environment for the server (merged under opts.env). Defaults to process.env. */
  baseEnv?: () => NodeJS.ProcessEnv
  /** Stable per-daemon identifier (the daemon's `--id`) used to name this host's
   *  server pid file. Must be the SAME across restarts of the daemon for one
   *  host/workspace so the next run can find and reap leftover server children.
   *  Defaults to 'default' (tests / in-process). */
  daemonId?: string
}

/** Where this daemon records its live server children's pids, so a NEXT run for
 *  the same host can reap any it left orphaned (e.g. after a hard crash that
 *  skipped killAll). Keyed by the daemon id — stable across restarts for one
 *  host. Lives under the system temp dir (always writable, cleared on reboot). */
export function serverPidFilePath(daemonId: string): string {
  // Sanitize the id into a safe filename component (ids are app-controlled, but
  // keep it defensive — they can contain path-ish characters).
  const safe = daemonId.replace(/[^a-zA-Z0-9_.-]/g, '_') || 'default'
  const pidRoot = process.env.CATE_E2E === '1' && process.env.CATE_E2E_USER_DATA
    ? process.env.CATE_E2E_USER_DATA
    : os.tmpdir()
  return path.join(pidRoot, 'cate-runtime', `ext-servers-${safe}.json`)
}

interface PidRecord { pid: number; id: string; startedAt: number; ownerPid?: number }

function readPidFile(file: string): PidRecord[] {
  try {
    const raw = fs.readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as PidRecord[]).filter((r) => r && typeof r.pid === 'number') : []
  } catch {
    return [] // missing or corrupt — treat as empty
  }
}

function writePidFile(file: string, records: PidRecord[]): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (records.length === 0) { try { fs.rmSync(file, { force: true }) } catch { /* gone */ } ; return }
    fs.writeFileSync(file, JSON.stringify(records))
  } catch { /* best-effort: a failed write just means a stale pid may linger */ }
}

/** Reap servers whose owning daemon has exited. Preserve live owners even if
 * another daemon uses the same id. Legacy records without an owner retain the
 * previous cleanup behavior. PID reuse can conservatively defer orphan cleanup. */
export function reapOrphanServers(daemonId: string): void {
  const file = serverPidFilePath(daemonId)
  const retained: PidRecord[] = []
  for (const rec of readPidFile(file)) {
    if (rec.pid <= 0) continue
    if (rec.ownerPid && rec.ownerPid > 0) {
      try {
        process.kill(rec.ownerPid, 0)
        retained.push(rec)
        continue
      } catch (error) {
        // Only ESRCH proves the owner is gone; lack of permission does not.
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          retained.push(rec)
          continue
        }
      }
    }
    try { process.kill(rec.pid, 'SIGKILL') } catch { /* ESRCH or perms: already gone */ }
  }
  writePidFile(file, retained)
}

/** A built server capability plus a killAll() so the daemon reaps every live
 *  server child on shutdown (not part of the portable ServerHost interface). */
export interface ServerCapability extends ServerHost {
  /** SIGKILL every live server child synchronously (daemon shutdown). */
  killAll(): void
}

const READY_PROBE_INTERVAL_MS = 150
const OUTPUT_TAIL_LIMIT = 8192

/** Allocate a free TCP port on 127.0.0.1 by binding an ephemeral listener, then
 *  closing it and returning the port the OS chose. There is a small TOCTOU
 *  window between close and the child re-binding — another process could grab
 *  the port. The child treats an EADDRINUSE as fatal (it exits), which the ready
 *  probe surfaces as a start rejection; in practice the window is microseconds. */
function allocatePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

export function createServerCapability(deps: ServerDeps = {}): ServerCapability {
  const children = new Map<string, ChildProcess>()
  const baseEnv = deps.baseEnv ?? (() => process.env)
  const pidFile = serverPidFilePath(deps.daemonId ?? 'default')

  // Pid-file bookkeeping: append on spawn, remove on exit. Rewrites the whole
  // file each mutation (the live set is tiny — a handful of harness servers).
  const recordPid = (rec: PidRecord): void => {
    const all = readPidFile(pidFile)
    all.push(rec)
    writePidFile(pidFile, all)
  }
  const forgetPid = (pid: number): void => {
    const all = readPidFile(pidFile).filter((r) => r.pid !== pid)
    writePidFile(pidFile, all)
  }

  const killChild = (child: ChildProcess): void => {
    try { child.kill('SIGTERM') } catch { /* gone */ }
    setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, 1000)
  }

  return {
    async start(opts: ServerStartOptions, onOutput, onExit): Promise<ServerHandle> {
      const port = await allocatePort()

      const resolveArg = (value: string): string =>
        value.replaceAll(RUNTIME_INSTALL_ROOT_PLACEHOLDER, installRoot())
      const executable = opts.command[0] === RUNTIME_NODE_EXECUTABLE
        ? process.execPath
        : resolveArg(opts.command[0])
      const args = opts.command.slice(1).map(resolveArg)

      const mergedEnv = Object.fromEntries(
        Object.entries({ ...baseEnv(), ...opts.env, [opts.portEnv]: String(port) })
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
      const child = spawn(executable, args, {
        cwd: opts.cwd,
        env: (opts.includeCateCli ? catePathEnv(mergedEnv) : mergedEnv) as NodeJS.ProcessEnv,
        stdio: [opts.bootstrapStdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
      if (opts.bootstrapStdin !== undefined) {
        // A spawn failure can close stdin before the write lands. The child
        // `error` handler below reports the useful launch error, so suppress
        // the secondary EPIPE from this one-shot bootstrap stream.
        child.stdin?.on('error', () => {})
        child.stdin?.end(opts.bootstrapStdin)
      }
      children.set(opts.id, child)
      // Record the live pid so a NEXT daemon run can reap it if we crash without
      // running killAll(). Removed on exit (below) and by killAll() on shutdown.
      if (child.pid) recordPid({ pid: child.pid, id: opts.id, startedAt: Date.now(), ownerPid: process.pid })

      // Ring-buffer the last ~8KB of COMBINED output so an early exit / failed
      // ready probe can report WHY the server died (its output is otherwise lost
      // on a remote host — it streams to evt frames the client may not surface).
      let outputTail = ''
      const appendTail = (s: string) => {
        outputTail += s
        if (outputTail.length > OUTPUT_TAIL_LIMIT) outputTail = outputTail.slice(-OUTPUT_TAIL_LIMIT)
      }

      child.stdout?.setEncoding('utf-8')
      child.stdout?.on('data', (chunk: string) => { appendTail(chunk); onOutput(opts.id, 'stdout', chunk) })
      child.stderr?.setEncoding('utf-8')
      child.stderr?.on('data', (chunk: string) => { appendTail(chunk); onOutput(opts.id, 'stderr', chunk) })

      // start() settles exactly once: either the ready probe passes (resolve) or
      // we hit timeout / spawn error / early exit (reject). After it settles, the
      // exit/error handlers just forward onExit.
      return await new Promise<ServerHandle>((resolve, reject) => {
        let settled = false
        let probeTimer: ReturnType<typeof setInterval> | null = null
        let deadlineTimer: ReturnType<typeof setTimeout> | null = null

        const cleanupTimers = () => {
          if (probeTimer) { clearInterval(probeTimer); probeTimer = null }
          if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null }
        }

        const failStart = (message: string) => {
          if (settled) return
          settled = true
          cleanupTimers()
          children.delete(opts.id)
          killChild(child)
          reject(new Error(message))
        }

        const succeed = () => {
          if (settled) return
          settled = true
          cleanupTimers()
          resolve({ id: opts.id, pid: child.pid ?? -1, port })
        }

        // A spawn failure arrives as `error`, not `close`. Pre-ready it rejects
        // start; post-ready it's an exit. Without this listener it'd throw.
        child.on('error', (err) => {
          children.delete(opts.id)
          if (child.pid) forgetPid(child.pid)
          if (settled) onExit(opts.id, -1, null)
          else failStart(err instanceof Error ? err.message : String(err))
        })
        child.on('close', (code, signal) => {
          children.delete(opts.id)
          if (child.pid) forgetPid(child.pid)
          if (settled) onExit(opts.id, code, signal)
          else failStart(`server exited before ready (code ${code}, signal ${signal})${outputTail.trim() ? `:\n${outputTail.trim()}` : ''}`)
        })

        // Ready probe: poll the ready path; ANY HTTP response (a status line
        // received) means the server is up. Connection errors are expected while
        // it's still binding, so they just retry until the deadline.
        const probe = () => {
          const req = http.get(`http://127.0.0.1:${port}${opts.readyPath}`, (res) => {
            res.resume() // drain
            succeed()
          })
          req.on('error', () => { /* not up yet; next interval retries */ })
          req.setTimeout(READY_PROBE_INTERVAL_MS, () => { req.destroy() })
        }

        deadlineTimer = setTimeout(() => {
          failStart(`server ready probe timed out after ${opts.readyTimeoutMs}ms${outputTail.trim() ? `:\n${outputTail.trim()}` : ''}`)
        }, opts.readyTimeoutMs)

        probeTimer = setInterval(probe, READY_PROBE_INTERVAL_MS)
        probe() // immediate first attempt
      })
    },

    stop(id: string): void {
      const child = children.get(id)
      if (!child) return
      children.delete(id)
      killChild(child)
    },

    killAll(): void {
      for (const child of children.values()) {
        try { child.kill('SIGKILL') } catch { /* gone */ }
      }
      children.clear()
      // Clean shutdown: drop the whole pid file so the next run has nothing stale
      // to reap (the children we just killed are gone).
      writePidFile(pidFile, [])
    },
  }
}
