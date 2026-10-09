// The daemon program, bundled as `runtime.cjs`:
//   node runtime.cjs serve <root> [--detach] [--network sameNetwork|cateConnect] [--json]
//   node runtime.cjs bridge <root>
// Without `--detach` it serves the workspace in this process. With it, it
// starts a detached copy of itself (stdio to `<data>/logs/`) and returns once
// that copy's socket answers, or at once when a runtime already serves root.
// `--network` is `cate serve`: network access on, the workspace trusted, and
// a pairing QR code and code printed for the first device (one JSON line
// with `--json`). `bridge` starts the runtime the same way when nothing
// answers, then carries its local socket over stdin and stdout: a client that
// can run a command on this machine (ssh, wsl.exe) reaches the runtime as a
// local client does (7.5).

import './loadPty'
import os from 'node:os'
import path from 'node:path'
import { createConsoleSink, combineSinks, createLogger, installLogSink } from '@kernel/log/contract'
import { createFileSink } from '@kernel/log/node'
import { runtimeIdFromCanonicalRoot } from '@runtime/data/contract'
import { canonicalRoot, cateHome, ensureLocalEndpoint, workspaceDataDir } from '@runtime/data/node'
import { ensureDataDir } from '@runtime/data/runtime'
import { dialLocal, dialLocalRetrying } from '@runtime/transports/node'
import { pairOverLocal, printPairing } from './compose/pairOverLocal'
import type { ByteDuplex } from '@kernel/rpc/contract'
import { BRIDGE_READY, installDirFromExecPath, installLayout, parseDaemonArgv, RUNTIME_BUILD, RUNTIME_RELEASE, RUNTIME_VERSION, START_LOCAL_BUDGET_MS, type ServeArgs } from './contract'
import { prepareDaemonProcess, serveWorkspace } from './entry'
import { pruneRuntimeInstalls, releaseRuntimeInUse, spawnDetachedDaemon } from './node'

const log = createLogger('daemon')

/** Connects to the runtime of `root`, starting a detached one from this
 *  program when nothing answers. */
async function connectOrStart(rootArg: string): Promise<{ root: string; endpoint: string; duplex: ByteDuplex }> {
  const root = await canonicalRoot(rootArg)
  const runtimeId = runtimeIdFromCanonicalRoot(root)
  const paths = await ensureDataDir(workspaceDataDir(runtimeId, os.homedir()))
  const endpoint = await ensureLocalEndpoint(paths.dir, runtimeId)
  try {
    return { root, endpoint, duplex: await dialLocal(endpoint, { timeoutMs: 1000 }) }
  } catch { /* not running */ }
  spawnDetachedDaemon({
    node: process.execPath,
    bundle: process.argv[1],
    args: { root },
    logFile: path.join(paths.logs, 'daemon.out.log'),
  })
  try {
    return { root, endpoint, duplex: await dialLocalRetrying(endpoint, { budgetMs: START_LOCAL_BUDGET_MS }) }
  } catch (err) {
    throw new Error(`${(err as Error).message}; see ${paths.logs}`)
  }
}

async function detach(args: ServeArgs): Promise<number> {
  try {
    const { root, endpoint, duplex } = await connectOrStart(args.root)
    duplex.close()
    // `cate serve` turns network on and shows a code through the socket, so
    // only this process prints one.
    if (args.network) await pairOverLocal(endpoint, args.network, root, args.json)
    return 0
  } catch (err) {
    process.stderr.write(`cate runtime: ${(err as Error).message}\n`)
    return 1
  }
}

/** Carries the runtime's local socket over stdin and stdout until either
 *  side closes. */
async function bridge(rootArg: string): Promise<number> {
  let duplex: ByteDuplex
  try {
    duplex = (await connectOrStart(rootArg)).duplex
  } catch (err) {
    process.stderr.write(`cate runtime: ${(err as Error).message}\n`)
    return 1
  }
  process.stdout.write(BRIDGE_READY)
  return new Promise((resolve) => {
    const done = () => resolve(0)
    duplex.onData((bytes) => { process.stdout.write(bytes) })
    duplex.onClose(done)
    process.stdin.on('data', (bytes: Buffer) => duplex.write(new Uint8Array(bytes)))
    process.stdin.once('end', () => { duplex.close('bridge closed'); done() })
    process.stdin.once('error', () => { duplex.close('bridge closed'); done() })
    process.stdout.once('error', () => { duplex.close('bridge closed'); done() })
  })
}

async function serve(args: ServeArgs): Promise<number> {
  const root = await canonicalRoot(args.root)
  const dataDir = workspaceDataDir(runtimeIdFromCanonicalRoot(root), os.homedir())
  // Warnings go to the terminal of a `cate serve` in the foreground; a
  // detached daemon's stdout is daemon.out.log, which they would only grow
  // (they are in the rotated daemon.log).
  const file = createFileSink({ file: path.join(dataDir, 'logs', 'daemon.log') })
  installLogSink(process.stdout.isTTY ? combineSinks(file, createConsoleSink('warn')) : file)

  // The login shell environment is captured once the socket is bound, so a
  // slow shell profile does not hold up the client's start.
  const result = await serveWorkspace({ root, network: args.network, log, prepareProcess: prepareDaemonProcess })
  if (result.kind === 'nested') {
    log.error(result.message)
    await result.closed
    return 1
  }
  if (result.kind === 'running') {
    log.info('%s is already served on %s', root, result.endpoint)
    if (args.network) await pairOverLocal(result.endpoint, args.network, root, args.json)
    return 0
  }
  const { daemon } = result
  if (args.network) await printPairing(root, daemon.pairing.createSecret(args.network), args.json)
  // Installs nothing uses go (an update leaves the previous one behind).
  // Only a release build from its own install: a checkout's leaves them alone.
  if (RUNTIME_RELEASE && RUNTIME_BUILD && path.basename(installDirFromExecPath(process.execPath, process.platform)) === RUNTIME_BUILD) {
    pruneRuntimeInstalls({ cateHome: cateHome(), keep: [RUNTIME_BUILD] })
      .then((removed) => { if (removed.length) log.info('removed unused runtime installs: %s', removed.join(', ')) })
      .catch((err: Error) => log.warn('pruning runtime installs: %s', err.message))
  }
  const onSignal = () => void daemon.stop({ kind: 'signal' })
  process.once('SIGTERM', onSignal)
  process.once('SIGINT', onSignal)

  const reason = await daemon.stopped
  releaseRuntimeInUse(installDirFromExecPath(process.execPath, process.platform), process.pid)
  if (reason.kind === 'update') {
    const next = installLayout(reason.installDir, process.platform)
    spawnDetachedDaemon({
      node: next.node,
      bundle: next.bundle,
      args: { root },
      logFile: path.join(daemon.paths.logs, 'daemon.out.log'),
    })
    log.info('restarting into %s', reason.version)
  }
  return 0
}

async function main(): Promise<void> {
  // Set by spawnDetachedDaemon for this process only.
  delete process.env.NODE_COMPILE_CACHE
  const parsed = parseDaemonArgv(process.argv.slice(2))
  if (parsed.command === 'error') {
    process.stderr.write(`${parsed.message}\n`)
    process.exit(2)
  }
  const code = parsed.command === 'bridge'
    ? await bridge(parsed.root)
    : parsed.args.detach ? await detach(parsed.args) : await serve(parsed.args)
  process.exit(code)
}

main().catch((err) => {
  log.error('daemon failed: %s', err)
  process.stderr.write(`cate runtime: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
