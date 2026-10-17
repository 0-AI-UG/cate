// The socket is the lock (section 7.3): a daemon that binds the workspace's
// local endpoint owns the workspace; one that cannot bind exits. A stopping
// daemon closes its socket before it lets go of the workspace's files, so a
// socket nobody answers is taken over only once the daemon that last owned it
// (the pid in runtime.json) is gone.

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { RUNTIME_STOP_DEADLINE_MS } from '../contract'
import { ensureLocalEndpoint } from '../node'
import { readRuntimeInfo } from './runtimeInfo'

export type SocketAcquire =
  | { kind: 'acquired'; server: net.Server; endpoint: string }
  | { kind: 'running'; endpoint: string }

export interface AcquireOptions {
  platform?: NodeJS.Platform
  /** How long a probe connect may take before the socket counts as stale. */
  probeTimeoutMs?: number
  /** How long the previous owner may take to exit. Default: a little over
   *  the stop deadline every daemon keeps. */
  ownerExitMs?: number
}

export async function acquireRuntimeSocket(
  dataDir: string,
  runtimeId: string,
  options: AcquireOptions = {},
): Promise<SocketAcquire> {
  const platform = options.platform ?? process.platform
  const endpoint = await ensureLocalEndpoint(dataDir, runtimeId, platform)
  const running = { kind: 'running', endpoint } as const

  const probeMs = options.probeTimeoutMs ?? 1000
  if (await socketAnswers(endpoint, probeMs)) return running
  if (platform !== 'win32') await awaitPreviousOwner(dataDir, options.ownerExitMs ?? RUNTIME_STOP_DEADLINE_MS + 1000)
  // Of two starts binding a free endpoint, exactly one succeeds.
  let server = await tryListen(endpoint)
  if (!server && platform === 'win32') {
    // A pipe goes when its owner dies: one that is taken but does not answer
    // belongs to a daemon still stopping. Wait for it, then take it.
    const until = Date.now() + (options.ownerExitMs ?? RUNTIME_STOP_DEADLINE_MS + 1000)
    while (!server) {
      if (await socketAnswers(endpoint, probeMs)) return running
      if (Date.now() > until) throw new Error(`${endpoint} is in use and nothing answers on it`)
      await new Promise((resolve) => setTimeout(resolve, 250))
      server = await tryListen(endpoint)
    }
  }
  if (!server) {
    // A socket file nobody answers on, left by a daemon that died. Starts
    // take it over one at a time: otherwise one could unlink the socket
    // another just bound, and both would serve the workspace.
    const taken = await withTakeoverLock(dataDir, async () => {
      if (await socketAnswers(endpoint, probeMs)) return null
      await removeStaleSocket(endpoint)
      return tryListen(endpoint)
    })
    if (!taken) {
      if (await socketAnswers(endpoint, probeMs)) return running
      throw new Error(`${endpoint} is in use and nothing answers on it`)
    }
    server = taken
  }
  if (platform !== 'win32') await fs.chmod(endpoint, 0o600)
  return { kind: 'acquired', server, endpoint }
}

/** Runs `fn` while holding `takeover.lock` in the data dir (created
 *  exclusively, holding the pid; a lock whose holder died is removed). */
async function withTakeoverLock<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
  const lock = path.join(dataDir, 'takeover.lock')
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      await fs.writeFile(lock, String(process.pid), { flag: 'wx' })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const holder = Number(await fs.readFile(lock, 'utf-8').catch(() => ''))
    if (!Number.isInteger(holder) || holder <= 0 || !alive(holder) || Date.now() > deadline) {
      await fs.rm(lock, { force: true })
      continue
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  try {
    return await fn()
  } finally {
    await fs.rm(lock, { force: true })
  }
}

/** Whether something accepts a connection on `endpoint`. */
export function socketAnswers(endpoint: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(endpoint)
    const done = (alive: boolean) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(alive)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** Waits for the daemon that last owned the workspace to exit. One still
 *  alive after `timeoutMs` is stuck in its shutdown: it no longer serves
 *  anyone but still holds the workspace's files, so it is killed. A pid that
 *  now belongs to another program (reused) is left alone. */
async function awaitPreviousOwner(dataDir: string, timeoutMs: number): Promise<void> {
  const pid = (await readRuntimeInfo(dataDir))?.pid
  if (!Number.isInteger(pid) || pid! <= 0 || pid === process.pid) return
  if (!alive(pid!) || !(await isRuntimeProcess(pid!))) return
  const deadline = Date.now() + timeoutMs
  while (alive(pid!) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
  if (!alive(pid!)) return
  try { process.kill(pid!, 'SIGKILL') } catch { return }
  const killed = Date.now() + 2000
  while (alive(pid!) && Date.now() < killed) await new Promise((resolve) => setTimeout(resolve, 20))
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Whether `pid` runs the daemon program (`runtime.cjs`). */
function isRuntimeProcess(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8', timeout: 2000 }, (error, stdout) => {
      resolve(!error && stdout.includes('runtime.cjs'))
    })
  })
}

async function removeStaleSocket(endpoint: string): Promise<void> {
  let stat
  try {
    stat = await fs.lstat(endpoint)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  // Never delete something that is not a socket.
  if (!stat.isSocket()) throw new Error(`${endpoint} exists and is not a socket`)
  await fs.rm(endpoint, { force: true })
}

/** A server bound to `endpoint`, or null when the endpoint is in use. */
function tryListen(endpoint: string): Promise<net.Server | null> {
  const server = net.createServer()
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.close()
      if (error.code === 'EADDRINUSE') resolve(null)
      else reject(error)
    }
    server.once('error', onError)
    server.listen(endpoint, () => {
      server.off('error', onError)
      resolve(server)
    })
  })
}
