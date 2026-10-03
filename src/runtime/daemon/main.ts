// The daemon program, bundled as `runtime.cjs`:
//   node runtime.cjs serve <root> [--detach] [--network sameNetwork|cateConnect] [--json]
// Without `--detach` it serves the workspace in this process. With it, it
// starts a detached copy of itself (stdio to `<data>/logs/`) and returns once
// that copy's socket answers, or at once when a runtime already serves root.
// `--network` is `cate serve`: network access on, the workspace trusted, and
// a pairing QR code and code printed for the first device (one JSON line
// with `--json`).

import './loadPty'
import os from 'node:os'
import path from 'node:path'
import { createConsoleSink, combineSinks, createLogger, installLogSink } from '@kernel/log/contract'
import { createFileSink } from '@kernel/log/node'
import { runtimeIdFromCanonicalRoot } from '@runtime/data/contract'
import QRCode from 'qrcode'
import { framePortOver } from '@kernel/rpc/contract'
import { RpcClient, createCapabilityProxy } from '@kernel/rpc/client'
import { settingsCapability } from '@kernel/settings/contract'
import { canonicalRoot, cateHome, ensureLocalEndpoint, workspaceDataDir } from '@runtime/data/node'
import { ensureDataDir } from '@runtime/data/runtime'
import { pairingCapability, PAIRING_SECRET_TTL_MS, type CreatedSecret, type PairingMode } from '@runtime/pairing/contract'
import { dialLocal, dialLocalRetrying } from '@runtime/transports/node'
import { installDirFromExecPath, installLayout, parseDaemonArgv, RUNTIME_BUILD, RUNTIME_RELEASE, RUNTIME_VERSION, START_LOCAL_BUDGET_MS, type ServeArgs } from './contract'
import { prepareDaemonProcess, serveWorkspace } from './entry'
import { pruneRuntimeInstalls, spawnDetachedDaemon } from './node'

const log = createLogger('daemon')

async function detach(args: ServeArgs): Promise<number> {
  const root = await canonicalRoot(args.root)
  const runtimeId = runtimeIdFromCanonicalRoot(root)
  const paths = await ensureDataDir(workspaceDataDir(runtimeId, os.homedir()))
  const endpoint = await ensureLocalEndpoint(paths.dir, runtimeId)
  if (await answers(endpoint)) {
    // Already served: `cate serve` still turns network on and shows a code.
    if (args.network) await pairOverLocal(endpoint, args.network, root, args.json)
    return 0
  }
  spawnDetachedDaemon({
    node: process.execPath,
    bundle: process.argv[1],
    args: { root, ...(args.network ? { network: args.network } : {}) },
    logFile: path.join(paths.logs, 'daemon.out.log'),
  })
  try {
    const duplex = await dialLocalRetrying(endpoint, { budgetMs: START_LOCAL_BUDGET_MS })
    duplex.close()
    if (args.network) await pairOverLocal(endpoint, args.network, root, args.json)
    return 0
  } catch (err) {
    process.stderr.write(`cate runtime: ${(err as Error).message}; see ${paths.logs}\n`)
    return 1
  }
}

async function answers(endpoint: string): Promise<boolean> {
  try {
    (await dialLocal(endpoint, { timeoutMs: 1000 })).close()
    return true
  } catch {
    return false
  }
}

async function serve(args: ServeArgs): Promise<number> {
  const root = await canonicalRoot(args.root)
  const dataDir = workspaceDataDir(runtimeIdFromCanonicalRoot(root), os.homedir())
  installLogSink(combineSinks(
    createFileSink({ file: path.join(dataDir, 'logs', 'daemon.log') }),
    createConsoleSink('warn'),
  ))

  await prepareDaemonProcess()
  const result = await serveWorkspace({ root, network: args.network, log })
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

/** Asks a running daemon, as a local client, to turn network on and for a
 *  pairing secret. */
async function pairOverLocal(endpoint: string, mode: PairingMode, root: string, json?: boolean): Promise<void> {
  const client = new RpcClient({
    version: RUNTIME_VERSION,
    identity: { client: { clientId: `serve-${process.pid}`, device: { name: 'cate serve', keyFingerprint: '' }, features: [] } },
  })
  try {
    await client.attach(framePortOver(await dialLocal(endpoint), 'stream'))
    await createCapabilityProxy(client, settingsCapability).set({ key: 'runtimeNetwork', value: mode })
    await printPairing(root, await createCapabilityProxy(client, pairingCapability).createSecret({ mode }), json)
  } finally {
    client.close()
  }
}

async function printPairing(root: string, created: CreatedSecret, json?: boolean): Promise<void> {
  if (json) {
    process.stdout.write(`${JSON.stringify({ root, uri: created.uri, code: created.code, expiresAt: created.expiresAt })}\n`)
    return
  }
  const qr = await QRCode.toString(created.uri, { type: 'terminal', small: true })
  const minutes = Math.round(PAIRING_SECRET_TTL_MS / 60_000)
  process.stdout.write([
    `Serving ${root}`,
    'Scan this code in Cate to pair a device:',
    '',
    qr,
    `Or type the pairing code: ${created.code}`,
    `It works once and expires in ${minutes} minutes.`,
    '',
  ].join('\n'))
}

async function main(): Promise<void> {
  const parsed = parseDaemonArgv(process.argv.slice(2))
  if (parsed.command === 'error') {
    process.stderr.write(`${parsed.message}\n`)
    process.exit(2)
  }
  const code = parsed.args.detach ? await detach(parsed.args) : await serve(parsed.args)
  process.exit(code)
}

main().catch((err) => {
  log.error('daemon failed: %s', err)
  process.stderr.write(`cate runtime: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
