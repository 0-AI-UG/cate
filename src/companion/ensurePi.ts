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
 *  (process.execPath == <installDir>/runtime/bin/node). pi sits at <installDir>/pi. */
function installRoot(): string {
  return path.resolve(path.dirname(process.execPath), '..', '..')
}

export function piCliPath(): string {
  return path.join(installRoot(), 'pi', 'dist', 'cli.js')
}

/** Resolves once pi is present. pi ships in the companion tarball, so this is a
 *  verify, not an install — a missing cli.js means a broken/partial provision. */
export function ensurePiOnHost(): Promise<void> {
  if (existsSync(piCliPath())) return Promise.resolve()
  return Promise.reject(new Error(`pi runtime missing at ${piCliPath()} — reinstall the companion`))
}
