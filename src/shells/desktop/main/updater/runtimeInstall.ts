// Installs the runtime this app ships to `~/.cate/runtime/<version>/` on start
// (architecture 7.3, 15), so starting a local workspace never waits on it. A
// packaged app ships the tarball in its resources; a dev checkout uses the one
// `npm run runtime:tarball` built, and falls back to the release download.

import fs from 'node:fs'
import path from 'node:path'
import { createLogger } from '@kernel/log/contract'
import { RUNTIME_VERSION, runtimeTarget, tarballName } from '@runtime/daemon/contract'
import { ensureRuntimeInstalled } from '@runtime/daemon/node'
import { cateHome } from '@runtime/data/node'

const log = createLogger('runtime-install')

export interface BundledTarballOptions {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
  version?: string
  platform?: NodeJS.Platform
  arch?: string
  exists?: (file: string) => boolean
}

/** The runtime tarball this build carries, or null. macOS ships one per
 *  architecture since one .app runs on both CPUs. */
function bundledRuntimeTarball(options: BundledTarballOptions): string | null {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const exists = options.exists ?? fs.existsSync
  if (options.isPackaged) {
    const name = platform === 'darwin' ? `runtime-host-${arch}.tgz` : 'runtime-host.tgz'
    const file = path.join(options.resourcesPath, name)
    return exists(file) ? file : null
  }
  const target = runtimeTarget(platform, arch)
  if (!target) return null
  const file = path.join(options.appPath, 'dist-runtime', tarballName(options.version ?? RUNTIME_VERSION, target))
  return exists(file) ? file : null
}

/** Resolves once this build's runtime is installed; rejects with a message the
 *  local dial can show. */
export async function installBundledRuntime(options: BundledTarballOptions & { home?: string }): Promise<string> {
  const version = options.version ?? RUNTIME_VERSION
  const tarball = bundledRuntimeTarball(options)
  const started = Date.now()
  const dir = await ensureRuntimeInstalled({
    version,
    cateHome: cateHome(options.home),
    ...(tarball ? { tarball } : {}),
    platform: options.platform,
    arch: options.arch,
  })
  log.info('runtime %s ready at %s (%d ms, from %s)', version, dir, Date.now() - started, tarball ?? 'release download')
  return dir
}
