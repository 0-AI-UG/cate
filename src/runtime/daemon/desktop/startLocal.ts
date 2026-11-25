// A client on the runtime's machine finds its workspace's runtime by the
// socket, and starts it when nothing answers (architecture 7.3). Desktop only:
// the client core receives the connected byte pipe from the shell.

import fs from 'node:fs'
import path from 'node:path'
import type { ByteDuplex } from '@kernel/rpc/contract'
import { DATA_FILES, runtimeIdFromCanonicalRoot } from '@runtime/data/contract'
import { canonicalRoot, ensureLocalEndpointFor, workspaceDataDir } from '@runtime/data/node'
import { dialLocal, dialLocalRetrying } from '@runtime/transports/node'
import { installLayout, START_LOCAL_BUDGET_MS } from '../contract'
import { spawnDetachedDaemon } from '../node'

export interface StartLocalOptions {
  root: string
  /** The user's home; default `os.homedir()`. */
  home?: string
  /** The install to start (`~/.cate/runtime/<build>/`). */
  installDir?: string
  /** Run this Node and bundle instead of an install (dev builds). */
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

/** The program that serves a workspace: an install's Node and bundle, or `launch`. */
function runtimeProgram(options: Pick<StartLocalOptions, 'installDir' | 'launch'>): { node: string; bundle: string } {
  const program = options.launch ?? (options.installDir ? installLayout(options.installDir, process.platform) : null)
  if (!program) throw new Error('no Cate runtime to start')
  return program
}

/** Connects to the workspace's runtime, starting it first if nothing answers. */
export async function startLocalRuntime(options: StartLocalOptions): Promise<LocalRuntime> {
  const root = await canonicalRoot(options.root)
  const runtimeId = runtimeIdFromCanonicalRoot(root)
  const endpoint = await ensureLocalEndpointFor(runtimeId, options.home)
  try {
    return { runtimeId, root, endpoint, duplex: await dialLocal(endpoint), started: false }
  } catch { /* not running */ }

  const { node, bundle } = runtimeProgram(options)
  if (!fs.existsSync(node)) throw new Error(`the Cate runtime is not installed (${node} is missing)`)
  // The serving process itself, detached: `serve --detach` would spawn a
  // second copy and cost another Node start and bundle load.
  spawnDetachedDaemon({
    node,
    bundle,
    args: { root },
    logFile: path.join(workspaceDataDir(runtimeId, options.home), DATA_FILES.logs, 'daemon.out.log'),
    env: options.env ?? process.env,
  })
  const duplex = await dialLocalRetrying(endpoint, { budgetMs: options.budgetMs ?? START_LOCAL_BUDGET_MS })
  return { runtimeId, root, endpoint, duplex, started: true }
}
