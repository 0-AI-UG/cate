// =============================================================================
// cate-companion daemon entry. Runs as a standalone Node program — locally as a
// child process, on a server over SSH exec, or inside WSL — and speaks the
// LF-JSON companion protocol over stdio. stdin carries `req` frames; stdout
// carries `hello` / `res` / `evt` frames. Nothing electron is imported here, so
// this bundles into a runtime-agnostic file (see build/esbuild.config.mjs).
//
// Usage: cate-companion --root <abs-path> --id <companionId> [--exclude a,b,c]
// =============================================================================

import { addAllowedRoot } from '../main/ipc/pathValidation'
import { RpcServer } from './rpcServer'
import { buildDaemonCompanion } from './capabilities'

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
    process.stderr.write('cate-companion: --root <abs-path> is required\n')
    process.exit(2)
  }
  return { root, id, exclusions, idleSuspend }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))

  // The daemon's filesystem sandbox: its workspace root (plus the system temp
  // dir, which pathValidation always allows). Everything the client asks for is
  // validated against this on the daemon side — the authoritative check, since
  // only the daemon can realpath its own filesystem.
  addAllowedRoot(args.root)

  const { companion, process: proc } = buildDaemonCompanion({
    id: args.id,
    exclusions: args.exclusions,
    idleSuspend: args.idleSuspend,
  })
  const server = new RpcServer(companion, (line) => process.stdout.write(line))

  // Reap every live pty's process group so quitting the app (which kills this
  // daemon) doesn't orphan dev-server children. Run before exit on every path.
  const shutdown = (): void => {
    proc.killAllGroups()
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

main()
