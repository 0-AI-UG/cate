// A client on the runtime's machine finds its workspace's runtime by the
// socket, and starts it when nothing answers (architecture 7.3). Desktop only:
// the portable client receives the connected byte pipe from the shell.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import type { ByteDuplex } from '@kernel/rpc/contract'
import { runtimeIdFromCanonicalRoot } from '@runtime/data/contract'
import { canonicalRoot, cateHome, ensureLocalEndpointFor } from '@runtime/data/node'
import { dialLocal, dialLocalRetrying } from '@runtime/transports/node'
import {
  installLayout,
  RUNTIME_VERSION,
  runtimeInstallDir,
  serveArgv,
  START_LOCAL_BUDGET_MS,
} from '../contract'

export interface StartLocalOptions {
  root: string
  /** The user's home; default `os.homedir()`. */
  home?: string
  /** Which installed release to start; default this build's. */
  version?: string
  /** Run this Node and bundle instead of the install (dev builds). */
  launch?: { node: string; bundle: string }
  env?: NodeJS.ProcessEnv
  budgetMs?: number
}

export interface LocalRuntime {
  runtimeId: string
  root: string
  endpoint: string
  duplex: ByteDuplex
  /** This call started the runtime. */
  started: boolean
}

/** The argv that starts a workspace's runtime: `<node> <bundle> serve <root> --detach`. */
export function startCommand(root: string, options: Pick<StartLocalOptions, 'home' | 'version' | 'launch'> = {}): { node: string; args: string[] } {
  const layout = installLayout(
    runtimeInstallDir(cateHome(options.home), options.version ?? RUNTIME_VERSION, process.platform),
    process.platform,
  )
  const node = options.launch?.node ?? layout.node
  const bundle = options.launch?.bundle ?? layout.bundle
  return { node, args: [bundle, ...serveArgv({ root, detach: true })] }
}

/** Connects to the workspace's runtime, starting it first if nothing answers. */
export async function startLocalRuntime(options: StartLocalOptions): Promise<LocalRuntime> {
  const root = await canonicalRoot(options.root)
  const runtimeId = runtimeIdFromCanonicalRoot(root)
  const endpoint = await ensureLocalEndpointFor(runtimeId, options.home)
  try {
    return { runtimeId, root, endpoint, duplex: await dialLocal(endpoint), started: false }
  } catch { /* not running */ }

  const { node, args } = startCommand(root, options)
  if (!fs.existsSync(node)) throw new Error(`the Cate runtime is not installed (${node} is missing)`)
  const child = spawn(node, args, {
    detached: true,
    stdio: 'ignore',
    env: options.env ?? process.env,
    windowsHide: true,
  })
  child.on('error', () => { /* reported as the dial timing out */ })
  child.unref()
  const duplex = await dialLocalRetrying(endpoint, { budgetMs: options.budgetMs ?? START_LOCAL_BUDGET_MS })
  return { runtimeId, root, endpoint, duplex, started: true }
}
