// `cate serve [path] [--connect]` (architecture 7.1): starts the workspace's
// runtime from this install with network access on (same network, or Cate
// Connect with `--connect`). The daemon trusts the workspace and prints the
// pairing QR code and code. A command of the installed runtime, not an API
// method.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { installDirFromExecPath, installLayout, serveArgv, type ServeArgs } from '@runtime/daemon/contract'

export const SERVE_USAGE =
  'usage: cate serve [path] [--connect]\n' +
  '  Serves the workspace at path (default: the current directory) to paired devices\n' +
  '  on the same network, or through Cate Connect with --connect, and prints a pairing code.'

export type ParsedServe =
  | { kind: 'serve'; root: string; network: NonNullable<ServeArgs['network']> }
  | { kind: 'help' }
  | { kind: 'error'; message: string }

export function parseServeArgs(argv: readonly string[], cwd: string): ParsedServe {
  let root: string | undefined
  let connect = false
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') return { kind: 'help' }
    if (arg === '--connect') connect = true
    else if (arg.startsWith('-')) return { kind: 'error', message: `unknown option ${arg}` }
    else if (root === undefined) root = arg
    else return { kind: 'error', message: `unexpected argument ${arg}` }
  }
  return { kind: 'serve', root: path.resolve(cwd, root ?? '.'), network: connect ? 'cateConnect' : 'sameNetwork' }
}

export interface ServeDeps {
  cwd: string
  /** This CLI's Node: `<install>/runtime/bin/node`. */
  execPath: string
  platform: string
  stdout: (text: string) => void
  stderr: (text: string) => void
  exists?: (file: string) => boolean
  /** Runs a program with inherited stdio; resolves its exit code. */
  run?: (command: string, args: string[]) => Promise<number>
}

function runInherited(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })
}

/** The `serve` entry for `CliDeps.extraCommands`. */
export function serveCommand(deps: ServeDeps): (argv: string[]) => Promise<number> {
  return async (argv) => {
    const parsed = parseServeArgs(argv, deps.cwd)
    if (parsed.kind === 'help') {
      deps.stdout(SERVE_USAGE)
      return 0
    }
    if (parsed.kind === 'error') {
      deps.stderr(`cate serve: ${parsed.message}`)
      deps.stderr(SERVE_USAGE)
      return 2
    }
    const layout = installLayout(installDirFromExecPath(deps.execPath, deps.platform), deps.platform)
    if (!(deps.exists ?? existsSync)(layout.bundle)) {
      deps.stderr(`cate serve: the Cate runtime is not installed next to this cate (${layout.bundle} is missing)`)
      return 3
    }
    const args = [layout.bundle, ...serveArgv({ root: parsed.root, detach: true, network: parsed.network })]
    return (deps.run ?? runInherited)(deps.execPath, args)
  }
}
