// The `cate` CLI in every terminal: its launcher directory on PATH, the local
// socket in CATE_SOCKET and a per-PTY token in CATE_TOKEN. The token is minted
// by the api router and names the terminal's panel, so the CLI acts as that
// panel. `cate` stays on PATH even without a token, so running it explains
// what is missing instead of "command not found".

import { existsSync } from 'node:fs'
import path from 'node:path'
import type { EnvContributor } from './extensions'

/** The runtime install dir: node runs from `<install>/runtime/bin/node`. */
function installRoot(execPath: string = process.execPath): string {
  return path.resolve(path.dirname(execPath), '..', '..')
}

/** Directory holding the `cate` / `cate.cmd` launchers. */
export function cateBinDir(root: string = installRoot()): string {
  return path.join(root, 'cate', 'bin')
}

/** Prepends `dir` to the env's PATH, whatever its case (Windows uses `Path`). */
export function prependPath(env: Readonly<Record<string, string>>, dir: string): Record<string, string> {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  return { [key]: env[key] ? dir + path.delimiter + env[key] : dir }
}

export interface CateCliEnvOptions {
  socketPath: string
  /** Mints a CLI token naming the panel (the api router's token registry). */
  mintToken: (panelId: string) => string | Promise<string>
  /** Defaults to the bundled launchers; left off PATH when the directory is
   *  missing (a daemon run from source). */
  binDir?: string
}

export function cateCliEnvContributor(options: CateCliEnvOptions): EnvContributor {
  const binDir = options.binDir ?? cateBinDir()
  let present: boolean | undefined
  return async (spawn) => {
    present ??= existsSync(binDir)
    const env: Record<string, string> = {
      ...(present ? prependPath(spawn.env, binDir) : {}),
      CATE_SOCKET: options.socketPath,
    }
    if (spawn.panelId) env.CATE_TOKEN = await options.mintToken(spawn.panelId)
    return env
  }
}
