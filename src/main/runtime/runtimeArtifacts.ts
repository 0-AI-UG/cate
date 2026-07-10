// =============================================================================
// Runtime artifacts — naming, release URLs, and a local tarball cache.
//
// The app ships NO runtime runtimes (see electron-builder.yml). Instead, one
// self-contained tarball per target (runtime.cjs + node_modules incl. the
// matching node-pty prebuild + a bundled Node runtime) is built in CI and
// uploaded to the GitHub release `v<version>`. On connect:
//   1. the remote pulls its own tarball directly from the release URL (fast —
//      bytes never transit the laptop); the transports do this over ssh/wsl.
//   2. if the remote has no internet, the client downloads the tarball here
//      (dev-built dist-runtime first, then a userData cache, then the release
//      URL) and the transport SFTP-pushes it.
//
// Keep GH_OWNER/GH_REPO in sync with the `publish:` block in electron-builder.yml.
// =============================================================================

import { app } from 'electron'
import { createHash } from 'crypto'
import path from 'path'
import { existsSync } from 'fs'
import { mkdir, rename, writeFile, readFile, stat } from 'fs/promises'
import log from '../logger'
import { GH_OWNER, GH_REPO, releaseTag } from '../../runtime/release'

/** Targets we build runtime tarballs for. WSL reuses the linux targets;
 *  win32-x64 is local-only (a Windows laptop running its OWN workspace daemon —
 *  there is no Windows remote, since ssh/wsl hosts are both Linux). */
export type RuntimeTarget = 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64' | 'win32-x64'

export const RUNTIME_TARGETS: readonly RuntimeTarget[] = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
]

export function isRuntimeTarget(s: string): s is RuntimeTarget {
  return (RUNTIME_TARGETS as readonly string[]).includes(s)
}

/** This machine's runtime target, or null on an unsupported platform/arch
 *  (e.g. win32-arm64, which has no tarball yet). Used to provision + run the
 *  local workspace on the same daemon tarball as remote hosts. With 'win32-x64'
 *  now in the union, `win32-<arch>` composes to a real target on x64 Windows. */
export function hostRuntimeTarget(): RuntimeTarget | null {
  const t = `${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`
  return isRuntimeTarget(t) ? t : null
}

/** `cate-runtime-1.1.0-linux-x64.tgz` */
export function tarballName(version: string, target: RuntimeTarget): string {
  return `cate-runtime-${version}-${target}.tgz`
}

/** Public download URL for a target's tarball on the GitHub release. */
export function releaseUrl(version: string, target: RuntimeTarget): string {
  return `https://github.com/${GH_OWNER}/${GH_REPO}/releases/download/${releaseTag(version)}/${tarballName(version, target)}`
}

/** Dev-built tarball produced by `npm run runtime:tarball` (unpackaged only). */
function devTarball(version: string, target: RuntimeTarget): string | null {
  if (app.isPackaged) return null
  const p = path.join(app.getAppPath(), 'dist-runtime', tarballName(version, target))
  return existsSync(p) ? p : null
}

/** True when running unpackaged (dev). In dev the transports prefer local
 *  artifacts, skip the release remote-pull, and hot-swap just runtime.cjs when
 *  the host is already provisioned — so iterating on the daemon needs neither a
 *  version bump nor a full tarball rebuild. Override off with CATE_RUNTIME_DEV=0. */
export function isRuntimeDevMode(): boolean {
  if (process.env.CATE_RUNTIME_DEV === '0') return false
  return !app.isPackaged || process.env.CATE_RUNTIME_DEV === '1'
}

/** The freshly built daemon bundle (`dist-runtime/runtime.cjs`) on this
 *  machine, if present. Null in a packaged app. This is the 262KB file the dev
 *  fast-push overlays onto an already-provisioned host after `build:runtime`. */
export function localRuntimeBundlePath(): string | null {
  if (app.isPackaged) return null
  const p = path.join(app.getAppPath(), 'dist-runtime', 'runtime.cjs')
  return existsSync(p) ? p : null
}

/** Where client-downloaded tarballs are cached between connects. */
function cacheDir(): string {
  return path.join(app.getPath('userData'), 'runtime-cache')
}

function cachedTarball(version: string, target: RuntimeTarget): string {
  return path.join(cacheDir(), tarballName(version, target))
}

/** A local tarball if one is already present (dev build or cache) — no download.
 *  Used to hash-check the remote install so a changed daemon re-pushes in dev. */
export function localTarballIfPresent(version: string, target: RuntimeTarget): string | null {
  const dev = devTarball(version, target)
  if (dev) return dev
  const cached = cachedTarball(version, target)
  return existsSync(cached) ? cached : null
}

/** The host-target runtime tarball shipped inside the packaged app, or null in
 *  dev / when absent. macOS ships a per-arch daemon (runtime-host-<arch>.tgz)
 *  because one .app can run on either CPU — an Intel Mac (process.arch === 'x64',
 *  natively or under Rosetta) must get the x64 daemon, since an arm64 node/node-pty
 *  can't exec there. Other platforms ship a single host-arch runtime-host.tgz. */
export function shippedRuntimeTarball(): string | null {
  if (!app.isPackaged) return null
  const name = process.platform === 'darwin'
    ? `runtime-host-${process.arch}.tgz`
    : 'runtime-host.tgz'
  const tarball = path.join(process.resourcesPath, name)
  return existsSync(tarball) ? tarball : null
}

/** Short content hash of a local tarball, for the remote `.ok` marker. */
export async function tarballHash(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex').slice(0, 16)
}

/**
 * Return a local path to the target's tarball for the SFTP-push fallback,
 * downloading it from the release if needed. Prefers a dev build, then the
 * cache, then the network. Throws with a clear message if all sources fail.
 */
export async function ensureLocalTarball(version: string, target: RuntimeTarget): Promise<string> {
  const dev = devTarball(version, target)
  if (dev) return dev

  const cached = cachedTarball(version, target)
  if (existsSync(cached) && (await stat(cached)).size > 0) return cached

  const url = releaseUrl(version, target)
  log.info('[runtime] downloading %s', url)
  let res: Response
  try {
    res = await fetch(url)
  } catch (err) {
    throw new Error(`Could not reach the runtime release (${url}): ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!res.ok) {
    throw new Error(
      `Runtime tarball not found for ${target} at ${url} (HTTP ${res.status}). ` +
        (app.isPackaged
          ? 'The release may not include this target yet.'
          : 'In dev, build it first: `npm run runtime:tarball` (optionally with --docker for linux).'),
    )
  }
  const buf = Buffer.from(await res.arrayBuffer())
  await mkdir(cacheDir(), { recursive: true })
  const tmp = `${cached}.${process.pid}.part`
  await writeFile(tmp, buf)
  await rename(tmp, cached)
  return cached
}
