// Long-lived HTTP server children (T3 runs on this). A child gets a free
// loopback port in `env[portEnv]`, its output is streamed, and `start`
// resolves only once an HTTP request to its ready path gets any response.
// Live pids are recorded in the data dir, with the command and start time the
// OS reports, so the next daemon can reap children a crashed one left behind
// and never a process that reused one of their pids.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import { readJsonFile, writeJsonFile, removeFile } from '@kernel/state/node'
import {
  RUNTIME_INSTALL_ROOT_PLACEHOLDER,
  RUNTIME_NODE_EXECUTABLE,
  type ServerHandle,
  type ServerStartOptions,
} from '../contract'

export interface ServerHostDeps {
  /** `<data>/servers.json`. */
  pidFile: string
  /** Resolves `RUNTIME_INSTALL_ROOT_PLACEHOLDER`. */
  installDir: string
  /** Resolves `RUNTIME_NODE_EXECUTABLE`. Default `process.execPath`. */
  nodePath?: string
  /** Environment under `opts.env`. Default `process.env`. */
  baseEnv?: () => NodeJS.ProcessEnv
  /** Adds the bundled `cate` CLI to PATH, for `includeCateCli`. */
  withCateCli?: (env: Record<string, string>) => Record<string, string>
}

export type ServerOutputListener = (id: string, stream: 'stdout' | 'stderr', chunk: string) => void
export type ServerExitListener = (id: string, code: number | null, signal: string | null) => void

export interface ServerHost {
  start(opts: ServerStartOptions, onOutput: ServerOutputListener, onExit: ServerExitListener): Promise<ServerHandle>
  /** SIGTERM, then SIGKILL after 3 s; resolves once the child exited. */
  stop(id: string): Promise<void>
  /** SIGKILL every child now (daemon shutdown). */
  killAll(): void
  running(): number
}

interface PidRecord { pid: number; id: string; ownerPid: number; command: string; startedAt: string }

const READY_PROBE_INTERVAL_MS = 150
const STOP_GRACE_MS = 3_000
const OUTPUT_TAIL_LIMIT = 8192

function readPidFile(file: string): PidRecord[] {
  const parsed = readJsonFile<unknown>(file, [])
  return Array.isArray(parsed)
    ? parsed.filter((r): r is PidRecord => !!r && typeof r.pid === 'number' && typeof r.command === 'string' && typeof r.startedAt === 'string')
    : []
}

function writePidFile(file: string, records: PidRecord[]): void {
  if (records.length === 0) removeFile(file)
  else writeJsonFile(file, records, { mode: 0o600 })
}

/** What the OS reports for `pid`: its start time and command, or null when
 *  it is gone (or `ps` is unavailable, as on Windows). */
function processIdentity(pid: number): { startedAt: string; command: string } | null {
  if (process.platform === 'win32') return null
  try {
    const out = execFileSync('ps', ['-o', 'lstart=,command=', '-p', String(pid)], { encoding: 'utf-8', timeout: 2000 }).trim()
    // lstart is a fixed 24 characters: "Thu Oct  9 10:00:00 2026".
    return out.length > 24 ? { startedAt: out.slice(0, 24), command: out.slice(24).trim() } : null
  } catch {
    return null
  }
}

/** Kills the children of a previous daemon of this workspace that is gone,
 *  when the pid still runs the recorded command started at the recorded
 *  time. Run once the socket lock is held, so no live daemon owns the file. */
export function reapOrphanServers(pidFile: string): void {
  const retained: PidRecord[] = []
  for (const record of readPidFile(pidFile)) {
    if (record.pid <= 0) continue
    if (record.ownerPid > 0 && record.ownerPid !== process.pid && ownerAlive(record.ownerPid)) {
      retained.push(record)
      continue
    }
    const now = processIdentity(record.pid)
    if (!now || now.command !== record.command || now.startedAt !== record.startedAt) continue
    try { process.kill(record.pid, 'SIGKILL') } catch { /* already gone */ }
  }
  writePidFile(pidFile, retained)
}

function ownerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Only ESRCH proves the owner is gone; EPERM means it lives.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Binds an ephemeral loopback port and releases it for the child. The gap
 *  before the child binds is tiny; a lost race fails the ready probe. */
function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

export function createServerHost(deps: ServerHostDeps): ServerHost {
  const children = new Map<string, ChildProcess>()
  const baseEnv = deps.baseEnv ?? (() => process.env)
  let nextId = 1

  const recordPid = (record: PidRecord) => writePidFile(deps.pidFile, [...readPidFile(deps.pidFile), record])
  const forgetPid = (pid: number) => writePidFile(deps.pidFile, readPidFile(deps.pidFile).filter((r) => r.pid !== pid))

  const killChild = (child: ChildProcess): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    try { child.kill('SIGTERM') } catch { /* gone */ }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, STOP_GRACE_MS)
    timer.unref?.()
    return exited.finally(() => clearTimeout(timer))
  }

  const resolveArg = (value: string) => value.replaceAll(RUNTIME_INSTALL_ROOT_PLACEHOLDER, deps.installDir)

  return {
    async start(opts, onOutput, onExit) {
      const id = `server-${nextId++}`
      const port = await allocatePort()
      const executable = opts.command[0] === RUNTIME_NODE_EXECUTABLE
        ? deps.nodePath ?? process.execPath
        : resolveArg(opts.command[0])
      const args = opts.command.slice(1).map(resolveArg)
      const merged = Object.fromEntries(
        Object.entries({ ...baseEnv(), ...opts.env, [opts.portEnv]: String(port) })
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
      const env = opts.includeCateCli && deps.withCateCli ? deps.withCateCli(merged) : merged

      const child = spawn(executable, args, {
        cwd: opts.cwd,
        env,
        stdio: [opts.bootstrapStdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
      if (opts.bootstrapStdin !== undefined) {
        // A failed spawn closes stdin before the write lands; `error` below
        // reports the real cause.
        child.stdin?.on('error', () => {})
        child.stdin?.end(opts.bootstrapStdin)
      }
      children.set(id, child)
      const identity = child.pid ? processIdentity(child.pid) : null
      if (child.pid && identity) recordPid({ pid: child.pid, id, ownerPid: process.pid, ...identity })

      // The last few KB of output explain an early exit or a failed probe.
      let tail = ''
      const append = (chunk: string) => {
        tail += chunk
        if (tail.length > OUTPUT_TAIL_LIMIT) tail = tail.slice(-OUTPUT_TAIL_LIMIT)
      }
      child.stdout?.setEncoding('utf-8')
      child.stdout?.on('data', (chunk: string) => { append(chunk); onOutput(id, 'stdout', chunk) })
      child.stderr?.setEncoding('utf-8')
      child.stderr?.on('data', (chunk: string) => { append(chunk); onOutput(id, 'stderr', chunk) })
      const withTail = (message: string) => (tail.trim() ? `${message}:\n${tail.trim()}` : message)

      return new Promise<ServerHandle>((resolve, reject) => {
        let settled = false
        let probeTimer: ReturnType<typeof setInterval> | null = null
        let deadline: ReturnType<typeof setTimeout> | null = null
        const clearTimers = () => {
          if (probeTimer) clearInterval(probeTimer)
          if (deadline) clearTimeout(deadline)
          probeTimer = deadline = null
        }
        const failStart = (message: string) => {
          if (settled) return
          settled = true
          clearTimers()
          children.delete(id)
          void killChild(child)
          reject(new Error(message))
        }
        const exited = (code: number | null, signal: string | null, message: string) => {
          children.delete(id)
          if (child.pid) forgetPid(child.pid)
          if (settled) onExit(id, code, signal)
          else failStart(message)
        }
        child.on('error', (err) => exited(-1, null, err.message))
        child.on('close', (code, signal) =>
          exited(code, signal, withTail(`server exited before ready (code ${code}, signal ${signal})`)))

        const probe = () => {
          const req = http.get(`http://127.0.0.1:${port}${opts.readyPath}`, (res) => {
            res.resume()
            if (settled) return
            settled = true
            clearTimers()
            resolve({ id, pid: child.pid ?? -1, port })
          })
          req.on('error', () => { /* not listening yet */ })
          req.setTimeout(READY_PROBE_INTERVAL_MS, () => req.destroy())
        }
        deadline = setTimeout(
          () => failStart(withTail(`server ready probe timed out after ${opts.readyTimeoutMs}ms`)),
          opts.readyTimeoutMs,
        )
        probeTimer = setInterval(probe, READY_PROBE_INTERVAL_MS)
        probe()
      })
    },

    async stop(id) {
      const child = children.get(id)
      if (!child) return
      children.delete(id)
      await killChild(child)
    },

    killAll() {
      const owned = new Set<number>()
      for (const child of children.values()) {
        if (child.pid) owned.add(child.pid)
        try { child.kill('SIGKILL') } catch { /* gone */ }
      }
      children.clear()
      writePidFile(deps.pidFile, readPidFile(deps.pidFile).filter((r) => !owned.has(r.pid)))
    },

    running: () => children.size,
  }
}
