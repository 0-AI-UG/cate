// Installing a runtime release into `~/.cate/runtime/<build>/`. Used by the
// desktop shell (it installs the tarball it ships) and by the daemon's
// `runtime.update` (it downloads the release). Installs are immutable: a
// complete install of a build is never replaced, so a daemon keeps running
// from the tree it started in.

import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { DATA_FILES, type RuntimeInfo } from '@runtime/data/contract'
import {
  checksumUrl,
  CURRENT_FILE,
  installLayout,
  isBuildId,
  releaseUrl,
  runtimeInstallDir,
  runtimeRoot,
  runtimeTarget,
  serveArgv,
  type RuntimeUpdateProgress,
  type ServeArgs,
} from '../contract'

const execFileP = promisify(execFile)

/** True when `installDir` holds a complete install. */
export function isRuntimeInstalled(installDir: string, platform: NodeJS.Platform = process.platform): boolean {
  const layout = installLayout(installDir, platform)
  return fs.existsSync(layout.node) && fs.existsSync(layout.bundle) && fs.existsSync(layout.marker)
}

/** `<runtime>/.<kind>-<pid>-<random>`: unique per call, and the pid tells
 *  pruning whether its owner still runs. */
function tempPath(cateHome: string, platform: NodeJS.Platform, kind: string): string {
  return path.join(runtimeRoot(cateHome, platform), `.${kind}-${process.pid}-${randomBytes(4).toString('hex')}`)
}

async function discard(dir: string): Promise<void> {
  // A tree can still be open in a running daemon on Windows; a leftover is
  // inert and pruned later.
  try { await rm(dir, { recursive: true, force: true }) } catch { /* in use */ }
}

/**
 * Extracts `tarball` into `<runtime>/<build>/`, the build read from the
 * tarball's `BUILD` file. The tree is extracted beside it, verified, marked
 * and renamed into place. When that build is already installed the existing
 * install is kept. Returns the install dir.
 */
export async function installRuntimeTarball(opts: {
  tarball: string
  cateHome: string
  /** Refuse a tarball of another build. */
  expectBuild?: string
  platform?: NodeJS.Platform
}): Promise<string> {
  const { tarball, cateHome } = opts
  const platform = opts.platform ?? process.platform
  const staging = tempPath(cateHome, platform, 'staging')
  const retired = tempPath(cateHome, platform, 'retired')
  await mkdir(staging, { recursive: true })
  try {
    await execFileP('tar', ['-xzf', tarball, '-C', staging])
    const layout = installLayout(staging, platform)
    for (const required of [layout.node, layout.bundle, layout.build]) {
      if (!fs.existsSync(required)) throw new Error(`runtime tarball ${tarball} has no ${path.relative(staging, required)}`)
    }
    const build = (await readFile(layout.build, 'utf-8')).trim()
    if (!isBuildId(build)) throw new Error(`runtime tarball ${tarball} has an invalid build id "${build}"`)
    if (opts.expectBuild !== undefined && build !== opts.expectBuild) {
      throw new Error(`runtime tarball ${tarball} is build ${build}, not ${opts.expectBuild}`)
    }
    const installDir = runtimeInstallDir(cateHome, build, platform)
    if (isRuntimeInstalled(installDir, platform)) return installDir
    await writeFile(layout.marker, build)
    // An incomplete leftover of this build (no marker) is set aside.
    if (fs.existsSync(installDir)) await rename(installDir, retired)
    try {
      await rename(staging, installDir)
    } catch (err) {
      // Another process installed the same build first.
      if (!isRuntimeInstalled(installDir, platform)) throw err
    }
    return installDir
  } finally {
    await discard(staging)
    await discard(retired)
  }
}

/** Downloads a release tarball from GitHub Releases to `dest` and checks it
 *  against the SHA-256 published beside it. */
export async function downloadRuntimeRelease(opts: {
  version: string
  dest: string
  platform?: NodeJS.Platform
  arch?: string
  fetch?: typeof fetch
  onProgress?: (received: number, total: number | null) => void
}): Promise<string> {
  const target = runtimeTarget(opts.platform ?? process.platform, opts.arch ?? process.arch)
  if (!target) throw new Error(`no runtime release for ${opts.platform ?? process.platform}-${opts.arch ?? process.arch}`)
  const get = async (url: string, onProgress?: (received: number, total: number | null) => void): Promise<Buffer> => {
    let res: Response
    try {
      res = await (opts.fetch ?? fetch)(url)
    } catch (err) {
      throw new Error(`could not reach the runtime release (${url}): ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!res.ok) throw new Error(`runtime release not found for ${target} at ${url} (HTTP ${res.status})`)
    if (!onProgress || !res.body) return Buffer.from(await res.arrayBuffer())
    const length = Number(res.headers.get('content-length'))
    const total = Number.isFinite(length) && length > 0 ? length : null
    const chunks: Uint8Array[] = []
    let received = 0
    onProgress(0, total)
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      received += value.length
      onProgress(received, total)
    }
    return Buffer.concat(chunks)
  }
  const url = releaseUrl(opts.version, target)
  const expected = (await get(checksumUrl(opts.version, target))).toString('utf-8').trim().split(/\s+/)[0]?.toLowerCase()
  const bytes = await get(url, opts.onProgress)
  if (bytes.length === 0) throw new Error(`runtime release at ${url} is empty`)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (!expected || actual !== expected) throw new Error(`runtime release at ${url} does not match its checksum`)
  await mkdir(path.dirname(opts.dest), { recursive: true })
  const partial = `${opts.dest}.part`
  await writeFile(partial, bytes)
  await rename(partial, opts.dest)
  return opts.dest
}

/** Points `~/.cate/runtime/current` at `installDir` (the install `cate` on
 *  PATH runs, `scripts/install.sh`). */
export async function setCurrentRuntime(cateHome: string, installDir: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const file = path.join(runtimeRoot(cateHome, platform), CURRENT_FILE)
  const partial = `${file}.${process.pid}.part`
  await writeFile(partial, `${path.basename(installDir)}\n`)
  await rename(partial, file)
}

/**
 * Makes a complete install and returns its dir: the install of `build` when
 * it is there, else `tarball` when given, else release `version` downloaded
 * from GitHub Releases. With `build`, a tarball or release of another build
 * is refused. The result becomes the current install.
 */
export async function ensureRuntimeInstalled(opts: {
  version: string
  build?: string
  cateHome: string
  tarball?: string
  platform?: NodeJS.Platform
  arch?: string
  fetch?: typeof fetch
  /** Told each step of a download and install (not called when the build is
   *  already installed). */
  onProgress?: (progress: RuntimeUpdateProgress) => void
}): Promise<string> {
  const platform = opts.platform ?? process.platform
  const { cateHome, onProgress } = opts
  let installDir = opts.build !== undefined ? runtimeInstallDir(cateHome, opts.build, platform) : undefined
  if (!installDir || !isRuntimeInstalled(installDir, platform)) {
    if (opts.tarball) {
      onProgress?.({ phase: 'install' })
      installDir = await installRuntimeTarball({ tarball: opts.tarball, cateHome, expectBuild: opts.build, platform })
    } else {
      const download = `${tempPath(cateHome, platform, 'download')}.tgz`
      try {
        await downloadRuntimeRelease({
          version: opts.version, dest: download, platform, arch: opts.arch, fetch: opts.fetch,
          ...(onProgress ? { onProgress: (received: number, total: number | null) => onProgress({ phase: 'download', received, total }) } : {}),
        })
        onProgress?.({ phase: 'install' })
        installDir = await installRuntimeTarball({ tarball: download, cateHome, expectBuild: opts.build, platform })
      } finally {
        await rm(download, { force: true })
      }
    }
  }
  await setCurrentRuntime(cateHome, installDir, platform)
  return installDir
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Builds that running daemons on this machine run (their `runtime.json`). */
async function liveBuilds(cateHome: string): Promise<string[]> {
  const dir = path.join(cateHome, 'workspaces')
  const ids = await readdir(dir).catch(() => [] as string[])
  const builds = await Promise.all(ids.map(async (id) => {
    try {
      const info = JSON.parse(await readFile(path.join(dir, id, DATA_FILES.runtimeInfo), 'utf-8')) as RuntimeInfo
      return typeof info.build === 'string' && isAlive(info.pid) ? [info.build] : []
    } catch {
      return []
    }
  }))
  return builds.flat()
}

/**
 * Removes installs under `~/.cate/runtime/` that nothing uses: not in `keep`,
 * not the current install, not run by a live daemon. Temporary trees of a
 * process that is gone go too. Best effort; returns the names removed.
 */
export async function pruneRuntimeInstalls(opts: {
  cateHome: string
  keep: string[]
  platform?: NodeJS.Platform
}): Promise<string[]> {
  const platform = opts.platform ?? process.platform
  const root = runtimeRoot(opts.cateHome, platform)
  const entries = await readdir(root).catch(() => [] as string[])
  const current = await readFile(path.join(root, CURRENT_FILE), 'utf-8').then((s) => s.trim(), () => '')
  const keep = new Set([...opts.keep, current, ...(await liveBuilds(opts.cateHome))])
  const removed: string[] = []
  for (const name of entries) {
    if (name === CURRENT_FILE || name.startsWith(`${CURRENT_FILE}.`) || keep.has(name)) continue
    const temp = /^\.[a-z]+-(\d+)-/.exec(name)
    if (temp && isAlive(Number(temp[1]))) continue
    try {
      await rm(path.join(root, name), { recursive: true, force: true })
      removed.push(name)
    } catch { /* in use (Windows); next time */ }
  }
  return removed
}

/**
 * Starts `node bundle serve <root>` as a detached process that outlives its
 * parent, with stdout and stderr appended to `logFile`. Does not wait.
 */
export function spawnDetachedDaemon(opts: {
  node: string
  bundle: string
  args: Omit<ServeArgs, 'detach'>
  logFile?: string
  env?: NodeJS.ProcessEnv
}): number | undefined {
  let out: number | 'ignore' = 'ignore'
  if (opts.logFile) {
    fs.mkdirSync(path.dirname(opts.logFile), { recursive: true })
    out = fs.openSync(opts.logFile, 'a', 0o600)
  }
  try {
    const child = spawn(opts.node, [opts.bundle, ...serveArgv({ ...opts.args, detach: false })], {
      detached: true,
      stdio: ['ignore', out, out],
      env: opts.env ?? process.env,
      windowsHide: true,
    })
    child.on('error', () => { /* the caller notices when the socket never answers */ })
    child.unref()
    return child.pid
  } finally {
    if (typeof out === 'number') fs.closeSync(out)
  }
}
