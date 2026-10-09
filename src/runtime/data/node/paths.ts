// Where a workspace's data and local endpoint live on this machine. Pure Node
// path helpers, shared by the daemon and the desktop shell (which may not
// import the runtime side).

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DATA_FILES, runtimeIdFromCanonicalRoot, windowsPipeName } from '../contract'

export function cateHome(home: string = os.homedir()): string {
  return path.join(home, '.cate')
}

export function workspacesDir(home?: string): string {
  return path.join(cateHome(home), 'workspaces')
}

export function workspaceDataDir(runtimeId: string, home?: string): string {
  return path.join(workspacesDir(home), runtimeId)
}

export async function canonicalRoot(root: string): Promise<string> {
  return fs.realpath(path.resolve(root))
}

export async function runtimeIdFor(root: string): Promise<string> {
  return runtimeIdFromCanonicalRoot(await canonicalRoot(root))
}

/** Longest socket path `bind`/`connect` accept, in bytes without the NUL
 *  (`sun_path` is 104 bytes on macOS and the BSDs, 108 on Linux). */
function socketPathMax(platform: NodeJS.Platform): number {
  return platform === 'linux' || platform === 'android' ? 107 : 103
}

/** Where a too-long endpoint is reached instead: `/tmp/cate-<uid>/<runtimeId>`
 *  is a symlink to the data dir, so the socket file itself stays in the data
 *  dir and still is the lock. `/tmp` rather than `os.tmpdir()`: every process
 *  (daemon, desktop, CLI) must compute the same path whatever its env. */
export function shortSocketDir(uid: number = process.getuid?.() ?? 0): string {
  return `/tmp/cate-${uid}`
}

/** The local transport: a socket in the data dir, or a named pipe on Windows.
 *  When the data dir path is too long for a socket (a long HOME), the socket
 *  is reached through a short symlinked dir; `ensureLocalEndpoint` makes it. */
export function localEndpoint(dataDir: string, runtimeId: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return windowsPipeName(runtimeId)
  const direct = path.join(dataDir, DATA_FILES.socket)
  if (Buffer.byteLength(direct) <= socketPathMax(platform)) return direct
  return path.join(shortSocketDir(), runtimeId, DATA_FILES.socket)
}

/** The local endpoint of a runtime by its id. */
export function localEndpointFor(runtimeId: string, home?: string, platform: NodeJS.Platform = process.platform): string {
  return localEndpoint(workspaceDataDir(runtimeId, home), runtimeId, platform)
}

/** `localEndpoint`, with the short symlink in place when it is needed. The
 *  daemon calls it before binding and every dialer before connecting; it is
 *  idempotent and repairs a link a tmp cleaner removed. Refuses a short dir
 *  another user could write to. */
export async function ensureLocalEndpoint(dataDir: string, runtimeId: string, platform: NodeJS.Platform = process.platform): Promise<string> {
  const endpoint = localEndpoint(dataDir, runtimeId, platform)
  if (platform === 'win32' || endpoint === path.join(dataDir, DATA_FILES.socket)) return endpoint
  const dir = shortSocketDir()
  await fs.mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  const stat = await fs.lstat(dir)
  const uid = process.getuid?.()
  if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
    throw new Error(`${dir} is not a private directory owned by this user`)
  }
  const link = path.join(dir, runtimeId)
  if (await linkTarget(link) === dataDir) return endpoint
  await fs.rm(link, { force: true })
  try {
    await fs.symlink(dataDir, link)
  } catch (error) {
    // A concurrent dialer made the same link.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await linkTarget(link) !== dataDir) throw error
  }
  return endpoint
}

async function linkTarget(link: string): Promise<string | undefined> {
  try {
    return await fs.readlink(link)
  } catch {
    return undefined
  }
}

/** `localEndpointFor` with the short symlink in place. */
export function ensureLocalEndpointFor(runtimeId: string, home?: string, platform: NodeJS.Platform = process.platform): Promise<string> {
  return ensureLocalEndpoint(workspaceDataDir(runtimeId, home), runtimeId, platform)
}
