// `cate serve [path] [--connect] [--json]` (architecture 7.1): shares a
// workspace of this machine. Through the install's `runtime.cjs bridge`, which
// starts the workspace's runtime when nothing answers, it connects as a local
// client and does what Share does in the app: trusts the workspace, turns
// network access on (same network, or Cate Connect with `--connect`) and
// prints a pairing QR code and code, or one JSON line with `--json`. Running
// it by hand is the person's confirmation. A command of the installed
// runtime, not an API method.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import QRCode from 'qrcode'
import { framePortOver, type ByteDuplex } from '@kernel/rpc/contract'
import { RpcClient, createCapabilityProxy } from '@kernel/rpc/client'
import { settingsCapability } from '@kernel/settings/contract'
import { BRIDGE_READY, installDirFromExecPath, installLayout, RUNTIME_VERSION } from '@runtime/daemon/contract'
import { pairingCapability, PAIRING_SECRET_TTL_MS, type CreatedSecret, type PairingMode } from '@runtime/pairing/contract'
import { workspaceCapability } from '@workspace/lifecycle/contract'

export const SERVE_SUMMARY = 'Serve a workspace to paired devices and print a pairing code'

export const SERVE_USAGE = `${SERVE_SUMMARY}

Usage:
  cate serve [<path>] [--connect] [--json]

Arguments:
  <path>      The workspace folder (default: the current directory)

Flags:
  --connect   Serve through Cate Connect instead of the same network only
  --json      Print the pairing details as one JSON line instead of a QR code
  -h, --help  Show this help`

export type ParsedServe =
  | { kind: 'serve'; root: string; network: PairingMode; json: boolean }
  | { kind: 'help' }
  | { kind: 'error'; message: string }

export function parseServeArgs(argv: readonly string[], cwd: string): ParsedServe {
  let root: string | undefined
  let connect = false
  let json = false
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') return { kind: 'help' }
    if (arg === '--connect') connect = true
    else if (arg === '--json') json = true
    else if (arg.startsWith('-')) return { kind: 'error', message: `unknown option ${arg}` }
    else if (root === undefined) root = arg
    else return { kind: 'error', message: `unexpected argument ${arg}` }
  }
  return { kind: 'serve', root: path.resolve(cwd, root ?? '.'), network: connect ? 'cateConnect' : 'sameNetwork', json }
}

/** Why `cate serve` must not run here, if so. Inside a Cate terminal it would
 *  share the workspace, and this computer, with whoever pairs, on the say of
 *  whatever runs in that terminal (an agent). */
export function serveRefusal(env: Readonly<Record<string, string | undefined>>): string | null {
  if (!(env.CATE_TOKEN || env.CATE_SOCKET)) return null
  return "cate serve can't run inside a Cate terminal; share the workspace from the app instead"
}

export interface ServeDeps {
  cwd: string
  env: Readonly<Record<string, string | undefined>>
  /** This CLI's Node: `<install>/runtime/bin/node`. */
  execPath: string
  platform: string
  stdout: (text: string) => void
  stderr: (text: string) => void
  exists?: (file: string) => boolean
  /** A byte pipe to the runtime of `root`, started if needed; default
   *  `node runtime.cjs bridge <root>` of this install. */
  bridge?: (node: string, bundle: string, root: string) => Promise<ByteDuplex>
}

/** Runs the install's bridge and resolves with its stdio once it printed
 *  `BRIDGE_READY`; rejects with what it said when it ends before. */
function runBridge(node: string, bundle: string, root: string): Promise<ByteDuplex> {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [bundle, 'bridge', root], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const ready = Buffer.from(BRIDGE_READY)
    let head = Buffer.alloc(0)
    let stderr = ''
    let listener: ((bytes: Uint8Array) => void) | null = null
    const pending: Uint8Array[] = []
    const onData = (chunk: Buffer) => {
      const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      if (listener) listener(bytes)
      else pending.push(bytes)
    }
    const onHead = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk])
      const at = head.indexOf(ready)
      if (at < 0) return
      child.stdout.removeListener('data', onHead)
      child.stdout.on('data', onData)
      const rest = head.subarray(at + ready.length)
      if (rest.byteLength) pending.push(new Uint8Array(rest.buffer, rest.byteOffset, rest.byteLength))
      resolve({
        write: (bytes) => { if (!child.stdin.destroyed) child.stdin.write(bytes) },
        onData: (next) => {
          listener = next
          for (const bytes of pending.splice(0)) next(bytes)
        },
        onClose: (next) => { child.once('close', () => next(undefined)) },
        close: () => { child.stdin.end() },
      })
    }
    child.stdout.on('data', onHead)
    child.stderr.setEncoding('utf-8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096) })
    child.stdin.on('error', () => { /* reported on close */ })
    child.once('error', reject)
    child.once('close', (code) => {
      reject(new Error(/cate runtime: (.*)/.exec(stderr)?.[1] ?? `the runtime bridge ended (exit ${code ?? 'killed'})`))
    })
  })
}

async function printPairing(stdout: (text: string) => void, root: string, created: CreatedSecret, json: boolean): Promise<void> {
  if (json) {
    stdout(JSON.stringify({ root, uri: created.uri, code: created.code, expiresAt: created.expiresAt }))
    return
  }
  const qr = await QRCode.toString(created.uri, { type: 'terminal', small: true })
  const minutes = Math.round(PAIRING_SECRET_TTL_MS / 60_000)
  stdout([
    `Serving ${root}`,
    'Scan this code in Cate to pair a device:',
    '',
    qr,
    `Or type the pairing code: ${created.code}`,
    `It works once and expires in ${minutes} minutes.`,
  ].join('\n'))
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
      deps.stderr(`cate: ${parsed.message}`)
      deps.stderr('Usage: cate serve [<path>] [--connect] [--json]')
      deps.stderr("Run 'cate serve --help' for usage.")
      return 2
    }
    const refusal = serveRefusal(deps.env)
    if (refusal) {
      deps.stderr(refusal)
      return 1
    }
    const layout = installLayout(installDirFromExecPath(deps.execPath, deps.platform), deps.platform)
    if (!(deps.exists ?? existsSync)(layout.bundle)) {
      deps.stderr(`cate serve: the Cate runtime is not installed next to this cate (${layout.bundle} is missing)`)
      return 3
    }
    // A local client with no device key: it is not recorded as a device.
    const client = new RpcClient({
      version: RUNTIME_VERSION,
      identity: { client: { clientId: `serve-${process.pid}`, device: { name: 'cate serve', publicKey: '' }, features: [] } },
    })
    let pipe: ByteDuplex | null = null
    try {
      pipe = await (deps.bridge ?? runBridge)(deps.execPath, layout.bundle, parsed.root)
      await client.attach(framePortOver(pipe, 'stream'))
      await createCapabilityProxy(client, workspaceCapability).setTrust({ trusted: true })
      await createCapabilityProxy(client, settingsCapability).set({ key: 'runtimeNetwork', value: parsed.network })
      const created = await createCapabilityProxy(client, pairingCapability).createSecret({ mode: parsed.network, acknowledged: true })
      await printPairing(deps.stdout, parsed.root, created, parsed.json)
      return 0
    } catch (err) {
      deps.stderr(`cate serve: ${err instanceof Error ? err.message : String(err)}`)
      return 1
    } finally {
      client.close()
      pipe?.close()
    }
  }
}
