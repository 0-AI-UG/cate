// =============================================================================
// cate-runtime daemon entry. Runs as a standalone Node program — locally as a
// child process, on a server over SSH exec, or inside WSL — and speaks the
// LF-JSON runtime protocol over stdio. stdin carries `req` frames; stdout
// carries `hello` / `res` / `evt` frames. Nothing electron is imported here, so
// this bundles into a runtime-agnostic file (see build/esbuild.config.mjs).
//
// Usage: cate-runtime --root <abs-path> --id <runtimeId> [--exclude a,b,c]
// =============================================================================

import { addAllowedRoot } from '../main/ipc/pathValidation'
import { RpcServer } from './rpcServer'
import { buildDaemonRuntime } from './capabilities'
import { hostHarnessRoot } from './capabilities/harnessRoot'
import { reapOrphanServers } from './capabilities/server'
import { applyLoginEnv } from './loginEnv'

interface DaemonArgs {
  root: string
  id: string
  exclusions: string[]
  idleSuspend: boolean
}

function parseArgs(argv: string[]): DaemonArgs {
  let root = ''
  let id = 'remote'
  let exclusions: string[] = []
  let idleSuspend = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') root = argv[++i] ?? ''
    else if (a === '--id') id = argv[++i] ?? id
    else if (a === '--exclude') exclusions = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--idle-suspend') idleSuspend = true
  }
  if (!root) {
    process.stderr.write('cate-runtime: --root <abs-path> is required\n')
    process.exit(2)
  }
  return { root, id, exclusions, idleSuspend }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  // Merge the user's login-shell env over process.env (skipped when the
  // launcher already resolved it — see loginEnv.ts). Awaited so the very first
  // spawn sees the same PATH a local daemon gets from getShellEnv().
  await applyLoginEnv()

  // The daemon's filesystem sandbox: its workspace root (plus the system temp
  // dir, which pathValidation always allows). Everything the client asks for is
  // validated against this on the daemon side — the authoritative check, since
  // only the daemon can realpath its own filesystem.
  addAllowedRoot(args.root, args.id)

  // T3 state is per host, independent of the currently open workspace.
  addAllowedRoot(hostHarnessRoot(), args.id)

  // Reap harness children left behind by a previous daemon crash.
  reapOrphanServers(args.id)

  const { runtime, process: proc, killAll } = buildDaemonRuntime({
    id: args.id,
    exclusions: args.exclusions,
    idleSuspend: args.idleSuspend,
  })
  const server = new RpcServer(runtime, (line) => process.stdout.write(line))

  const shutdown = (): void => {
    proc.killAllGroups()
    killAll()
    server.dispose()
    process.exit(0)
  }

  process.stdin.setEncoding('utf-8')
  process.stdin.on('data', (chunk) => server.handleChunk(chunk))
  process.stdin.on('close', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  server.start()
}

void main()
