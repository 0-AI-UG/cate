// Installing a runtime release into `~/.cate/runtime/<version>/`. Used by the
// desktop shell (it installs the tarball it ships) and by the daemon's
// `runtime.update` (it downloads the release).

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  installLayout,
  releaseUrl,
  runtimeInstallDir,
  runtimeTarget,
  serveArgv,
  type ServeArgs,
} from '../contract'

const execFileP = promisify(execFile)

/** True when `installDir` holds a complete install (and, if given, the marker matches). */
export function isRuntimeInstalled(installDir: string, platform: NodeJS.Platform = process.platform, marker?: string): boolean {
  const layout = installLayout(installDir, platform)
  if (!fs.existsSync(layout.node) || !fs.existsSync(layout.bundle) || !fs.existsSync(layout.marker)) return false
  return marker === undefined || fs.readFileSync(layout.marker, 'utf-8').trim() === marker
}

async function discard(dir: string): Promise<void> {
  // A retired tree can still be open in a running daemon on Windows; a
  // leftover is inert and removed by the next install.
  try { await rm(dir, { recursive: true, force: true }) } catch { /* in use */ }
}

/**
 * Extracts `tarball` into `installDir`. The tree is extracted beside it,
 * verified, marked, and swapped in by rename, so the dir is always either the
 * old complete install or the new one; a failed extract leaves the old one.
 */
export async function installRuntimeTarball(opts: {
  tarball: string
  installDir: string
  /** Written to `.ok` last. Default: the dir's name (the version). */
  marker?: string
  platform?: NodeJS.Platform
}): Promise<void> {
  const { tarball, installDir } = opts
  const platform = opts.platform ?? process.platform
  const staging = `${installDir}.staging-${process.pid}`
  const retired = `${installDir}.retired-${process.pid}`
  await mkdir(path.dirname(installDir), { recursive: true })
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    await execFileP('tar', ['-xzf', tarball, '-C', staging])
    const layout = installLayout(staging, platform)
    for (const required of [layout.node, layout.bundle]) {
      if (!fs.existsSync(required)) throw new Error(`runtime tarball ${tarball} has no ${path.relative(staging, required)}`)
    }
    await writeFile(layout.marker, opts.marker ?? path.basename(installDir))
    if (fs.existsSync(installDir)) await rename(installDir, retired)
    await rename(staging, installDir)
  } finally {
    await discard(staging)
    await discard(retired)
  }
}

/** Downloads a release tarball from GitHub Releases to `dest`. */
export async function downloadRuntimeRelease(opts: {
  version: string
  dest: string
  platform?: NodeJS.Platform
  arch?: string
  fetch?: typeof fetch
}): Promise<string> {
  const target = runtimeTarget(opts.platform ?? process.platform, opts.arch ?? process.arch)
  if (!target) throw new Error(`no runtime release for ${opts.platform ?? process.platform}-${opts.arch ?? process.arch}`)
  const url = releaseUrl(opts.version, target)
  let res: Response
  try {
    res = await (opts.fetch ?? fetch)(url)
  } catch (err) {
    throw new Error(`could not reach the runtime release (${url}): ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!res.ok) throw new Error(`runtime release not found for ${target} at ${url} (HTTP ${res.status})`)
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length === 0) throw new Error(`runtime release at ${url} is empty`)
  await mkdir(path.dirname(opts.dest), { recursive: true })
  const partial = `${opts.dest}.${process.pid}.part`
  await writeFile(partial, bytes)
  await rename(partial, opts.dest)
  return opts.dest
}

/**
 * Makes `~/.cate/runtime/<version>/` a complete install: already there (the
 * desktop app installs its own tarball on start), from `tarball` when given,
 * or downloaded from GitHub Releases. Returns the install dir.
 */
export async function ensureRuntimeInstalled(opts: {
  version: string
  cateHome: string
  tarball?: string
  platform?: NodeJS.Platform
  arch?: string
  fetch?: typeof fetch
}): Promise<string> {
  const platform = opts.platform ?? process.platform
  const installDir = runtimeInstallDir(opts.cateHome, opts.version, platform)
  if (isRuntimeInstalled(installDir, platform)) return installDir
  if (opts.tarball) {
    await installRuntimeTarball({ tarball: opts.tarball, installDir, marker: opts.version, platform })
    return installDir
  }
  const download = `${installDir}.download.tgz`
  try {
    await downloadRuntimeRelease({ version: opts.version, dest: download, platform, arch: opts.arch, fetch: opts.fetch })
    await installRuntimeTarball({ tarball: download, installDir, marker: opts.version, platform })
  } finally {
    await rm(download, { force: true })
  }
  return installDir
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
