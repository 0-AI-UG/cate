// The daemon's command line: `runtime.cjs serve <root> [--detach]`, or
// `runtime.cjs bridge <root>`. Pure, so the desktop shell, the `cate` CLI
// and the daemon agree on it.

export interface ServeArgs {
  root: string
  detach: boolean
}

export function serveArgv(args: ServeArgs): string[] {
  const argv = ['serve', args.root]
  if (args.detach) argv.push('--detach')
  return argv
}

export type ParsedDaemonArgs =
  | { command: 'serve'; args: ServeArgs }
  /** Starts the workspace's runtime when nothing answers, then carries its
   *  local socket over stdin and stdout (7.5). */
  | { command: 'bridge'; root: string }
  | { command: 'error'; message: string }

export const DAEMON_USAGE = 'usage: runtime.cjs serve <root> [--detach]\n       runtime.cjs bridge <root>'

/** What `bridge` prints on stdout once it is connected; the bytes after it
 *  are the socket's. Anything before it (a chatty login file) is not. */
export const BRIDGE_READY = 'CATE-BRIDGE-READY\n'

export function parseDaemonArgv(argv: readonly string[]): ParsedDaemonArgs {
  const [command, ...rest] = argv
  if (command === 'bridge') {
    return rest.length === 1 && rest[0] && !rest[0].startsWith('--')
      ? { command: 'bridge', root: rest[0] }
      : { command: 'error', message: DAEMON_USAGE }
  }
  if (command !== 'serve') return { command: 'error', message: DAEMON_USAGE }
  let root: string | undefined
  let detach = false
  for (const arg of rest) {
    if (arg === '--detach') detach = true
    else if (arg.startsWith('--')) return { command: 'error', message: `unknown option ${arg}\n${DAEMON_USAGE}` }
    else if (root === undefined) root = arg
    else return { command: 'error', message: DAEMON_USAGE }
  }
  if (!root) return { command: 'error', message: DAEMON_USAGE }
  return { command: 'serve', args: { root, detach } }
}

/** How long a local client keeps retrying after starting a runtime (7.3). */
export const START_LOCAL_BUDGET_MS = 10_000
