// =============================================================================
// cateCli (path helper) — resolves where the bundled `cate` CLI lives on the
// runtime host. The CLI ships INSIDE the runtime tarball (cate/ next to runtime/
// and pi/), so it is present the moment the daemon is provisioned. The
// env-injection layer prepends cateBinDir() to a terminal/agent shell's PATH so
// `cate` is callable there.
// =============================================================================

import path from 'path'
import { existsSync } from 'fs'
import { installRoot } from './installRoot'

/** Directory holding the `cate` / `cate.cmd` launcher shims. Prepend this to a
 *  shell's PATH to make `cate` callable. */
export function cateBinDir(): string {
  return path.join(installRoot(), 'cate', 'bin')
}

/** The bundled CLI entry (cate/dist/cli.cjs) the shims run under bundled node.
 *  Cross-platform JS — no win32 branch. */
export function cateCliPath(): string {
  return path.join(installRoot(), 'cate', 'dist', 'cli.cjs')
}

/** Put the bundled `cate` on a spawn env's PATH so agents and users can run it.
 *  Unconditional (not gated on CATE_API): the endpoint env is the real on/off
 *  switch, and keeping `cate` on PATH while the endpoint is disabled means
 *  running it prints how to enable the setting (see the EnvError message in
 *  src/cli/cate.ts) instead of a discoverability-killing "command not found".
 *  Runs daemon-side (process.execPath == the tarball node), where cateBinDir()
 *  is correct for local and remote hosts. No-ops when the CLI dir is absent
 *  (dev/direct mode runs the daemon from source, with no extracted tarball).
 *  Finds the PATH key case-insensitively (Windows uses `Path`). */
export function catePathEnv(env: Record<string, string>): Record<string, string> {
  const binDir = presentBinDir()
  if (!binDir) return env
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  return { ...env, [key]: binDir + path.delimiter + (env[key] ?? '') }
}

/** cateBinDir() is invariant for the daemon's lifetime (installRoot never
 *  moves), so stat it once and cache the result — spawns are a hot path and
 *  shouldn't re-hit the filesystem. Returns the dir when present, else null. */
let cachedBinDir: string | null | undefined
function presentBinDir(): string | null {
  if (cachedBinDir === undefined) {
    const binDir = cateBinDir()
    cachedBinDir = existsSync(binDir) ? binDir : null
  }
  return cachedBinDir
}
