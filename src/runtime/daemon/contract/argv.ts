// The daemon's command line: `runtime.cjs serve <root> [--detach] [--network
// sameNetwork|cateConnect] [--json]`. Pure, so the desktop shell and the
// daemon agree on it.

import type { RuntimeNetwork } from './settings'

export interface ServeArgs {
  root: string
  detach: boolean
  /** Network access to turn on for this runtime (`cate serve`). */
  network?: Exclude<RuntimeNetwork, 'off'>
  /** Print the pairing as one JSON line instead of a QR code (a program
   *  reads it: setup over SSH). */
  json?: boolean
}

export function serveArgv(args: ServeArgs): string[] {
  const argv = ['serve', args.root]
  if (args.detach) argv.push('--detach')
  if (args.network) argv.push('--network', args.network)
  if (args.json) argv.push('--json')
  return argv
}

export type ParsedDaemonArgs = { command: 'serve'; args: ServeArgs } | { command: 'error'; message: string }

export const DAEMON_USAGE = 'usage: runtime.cjs serve <root> [--detach] [--network sameNetwork|cateConnect] [--json]'

export function parseDaemonArgv(argv: readonly string[]): ParsedDaemonArgs {
  const [command, ...rest] = argv
  if (command !== 'serve') return { command: 'error', message: DAEMON_USAGE }
  let root: string | undefined
  let detach = false
  let json = false
  let network: ServeArgs['network']
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '--detach') detach = true
    else if (arg === '--json') json = true
    else if (arg === '--network') {
      const value = rest[++i]
      if (value !== 'sameNetwork' && value !== 'cateConnect') {
        return { command: 'error', message: `--network takes sameNetwork or cateConnect\n${DAEMON_USAGE}` }
      }
      network = value
    } else if (arg.startsWith('--')) return { command: 'error', message: `unknown option ${arg}\n${DAEMON_USAGE}` }
    else if (root === undefined) root = arg
    else return { command: 'error', message: DAEMON_USAGE }
  }
  if (!root) return { command: 'error', message: DAEMON_USAGE }
  return { command: 'serve', args: { root, detach, ...(network ? { network } : {}), ...(json ? { json } : {}) } }
}

/** How long a local client keeps retrying after starting a runtime (7.3). */
export const START_LOCAL_BUDGET_MS = 10_000
