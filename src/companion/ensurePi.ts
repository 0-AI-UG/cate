// =============================================================================
// ensurePi (daemon side) — install the pi runtime on the host the daemon runs
// on. pi is pulled on demand (cross-platform tarball) into ~/.cate/pi/<piVer>,
// cached by version. The host fetches its own bytes (curl, fetch fallback) from
// the GitHub release — same model as the companion bootstrap.
//
// AIR-GAPPED FALLBACK: a host with no internet (no curl AND fetch fails) can't
// pull. For that case the CLIENT pushes the tarball to <piDir>/pkg.tgz over the
// transport (SFTP for ssh, /mnt copy for wsl — see sshTransport.pushPi) and
// then re-invokes this ensure. `doInstall` checks for that pushed tarball FIRST,
// so when it's present we extract it and never touch the network. The push path
// is the symmetric mirror of the companion-tarball SFTP fallback.
// =============================================================================

import { existsSync } from 'fs'
import { mkdir, rm, writeFile } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import path from 'path'
import { piReleaseUrl } from './release'
import { PI_VERSION } from './piVersion'
import { COMPANION_VERSION } from './version'

const execFileP = promisify(execFile)

export function piInstallDir(): string {
  return path.join(os.homedir(), '.cate', 'pi', PI_VERSION)
}

export function piCliPath(): string {
  return path.join(piInstallDir(), 'dist', 'cli.js')
}

/** Where the client pushes the pi tarball for the air-gapped fallback. The
 *  daemon's doInstall extracts this in place of downloading when it exists. */
export function piPushedTarballPath(): string {
  return path.join(piInstallDir(), 'pkg.tgz')
}

let inflight: Promise<void> | null = null

/** Idempotent: resolves once ~/.cate/pi/<ver>/dist/cli.js exists on the host. */
export function ensurePiOnHost(): Promise<void> {
  if (existsSync(piCliPath())) return Promise.resolve()
  if (inflight) return inflight
  inflight = doInstall().finally(() => { inflight = null })
  return inflight
}

async function doInstall(): Promise<void> {
  const dir = piInstallDir()
  const cli = piCliPath()
  if (existsSync(cli)) return

  await mkdir(dir, { recursive: true })

  // 1. Pre-pushed tarball (air-gapped fallback): the client already placed the
  //    complete bytes at pkg.tgz over the transport. Extract it without any
  //    network access. The download path below uses a SEPARATE temp file, so a
  //    partial download is never mistaken for a pushed tarball.
  let tarball = piPushedTarballPath()
  if (!existsSync(tarball)) {
    // 2. Otherwise pull the bytes ourselves from the release (curl → fetch).
    tarball = path.join(dir, 'pkg.download.tgz')
    const url = piReleaseUrl(COMPANION_VERSION, PI_VERSION)
    try {
      await execFileP('curl', ['-fSL', url, '-o', tarball])
    } catch {
      // No curl, or curl failed — try Node's fetch.
      const res = await fetch(url)
      if (!res.ok) throw new Error(`pi download failed: HTTP ${res.status} (${url})`)
      await writeFile(tarball, Buffer.from(await res.arrayBuffer()))
    }
  }
  await execFileP('tar', ['-xzf', tarball, '-C', dir])
  await rm(tarball, { force: true })
  if (!existsSync(cli)) throw new Error(`pi install did not produce ${cli}`)
}
