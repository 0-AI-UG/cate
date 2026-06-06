// =============================================================================
// ensurePi (daemon side) — pi now ships INSIDE the companion tarball (pi/ next
// to runtime/ and companion.cjs), so it is present on the host the moment the
// daemon is provisioned. There is nothing to download or extract on demand: we
// resolve pi relative to the bundle and verify it exists. The air-gapped case is
// covered by the companion tarball's own SFTP/copy fallback, which now carries
// pi along with node + node-pty + ripgrep.
// =============================================================================

import { existsSync } from 'fs'
import path from 'path'

/** The companion install dir — two levels up from the bundled node runtime
 *  (process.execPath == <installDir>/runtime/bin/node[.exe]). The unified layout
 *  keeps node under runtime/bin/ on win32 too (just node.exe), so the dirname×3
 *  depth is identical across platforms and this stays correct. pi sits at
 *  <installDir>/pi. */
function installRoot(): string {
  return path.resolve(path.dirname(process.execPath), '..', '..')
}

/** pi is cross-platform JS — the bundled node runs dist/cli.js identically on
 *  every OS, so this path needs no win32 branch. */
export function piCliPath(): string {
  return path.join(installRoot(), 'pi', 'dist', 'cli.js')
}

/** Resolves once pi is present. pi ships in the companion tarball, so this is a
 *  verify, not an install — a missing cli.js means a broken/partial provision. */
export function ensurePiOnHost(): Promise<void> {
  if (existsSync(piCliPath())) return Promise.resolve()
  return Promise.reject(new Error(`pi runtime missing at ${piCliPath()}. Reinstall the companion.`))
}
