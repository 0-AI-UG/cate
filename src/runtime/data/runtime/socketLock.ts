// The socket is the lock (section 7.3): a daemon that binds the workspace's
// local endpoint owns the workspace; one that cannot bind exits.

import { promises as fs } from 'node:fs'
import net from 'node:net'
import { ensureLocalEndpoint } from '../node'

export type SocketAcquire =
  | { kind: 'acquired'; server: net.Server; endpoint: string }
  | { kind: 'running'; endpoint: string }

export interface AcquireOptions {
  platform?: NodeJS.Platform
  /** How long a probe connect may take before the socket counts as stale. */
  probeTimeoutMs?: number
}

export async function acquireRuntimeSocket(
  dataDir: string,
  runtimeId: string,
  options: AcquireOptions = {},
): Promise<SocketAcquire> {
  const platform = options.platform ?? process.platform
  const endpoint = await ensureLocalEndpoint(dataDir, runtimeId, platform)
  const running = { kind: 'running', endpoint } as const

  if (await answers(endpoint, options.probeTimeoutMs ?? 1000)) return running
  if (platform !== 'win32') await removeStaleSocket(endpoint)

  const server = net.createServer()
  try {
    await listen(server, endpoint)
  } catch (error) {
    server.close()
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return running
    throw error
  }
  // Two daemons racing over the same stale socket can both get here; the
  // window is the gap between the other's unlink and bind, and it needs a
  // crashed daemon plus two simultaneous starts to hit.
  if (platform !== 'win32') await fs.chmod(endpoint, 0o600)
  return { kind: 'acquired', server, endpoint }
}

function answers(endpoint: string, timeoutMs: number): Promise<boolean> {
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

function listen(server: net.Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(endpoint, () => {
      server.off('error', onError)
      resolve()
    })
  })
}
