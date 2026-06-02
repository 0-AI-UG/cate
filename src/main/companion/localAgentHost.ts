// =============================================================================
// localAgentHost — the local machine's AgentHost. Runs pi the same way the
// daemon does (the shared agent capability), but resolves pi locally:
//   - dev: pi is in the app's node_modules (unpruned) — use it directly.
//   - packaged: pi is NOT bundled; extract the on-demand cate-pi tarball into
//     userData/pi/<ver> (downloaded from the release / dev dist-companion).
// pi's cli.js always lands on the real filesystem (never inside asar), so it can
// run under either a real `node` or Electron-acting-as-node.
//
// node selection: on Windows we PREFER a real system node.exe when one is on
// PATH, because launching Electron with ELECTRON_RUN_AS_NODE=1 in a packaged
// build hits an ICU fd startup failure there. macOS/Linux stay on Electron-as-
// node (known-good, and independent of whatever node the user has installed).
// When no system node is found we fall back to Electron-as-node everywhere.
// =============================================================================

import { app } from 'electron'
import { accessSync, constants, existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import log from '../logger'
import { getShellEnv } from '../shellEnv'
import { createAgentCapability } from '../../companion/capabilities/agent'
import { PI_VERSION } from '../../companion/piVersion'
import { ensureLocalPiTarball } from './companionArtifacts'
import type { AgentHost } from './types'

const execFileP = promisify(execFile)

/**
 * First `node` binary on `pathVar`, or null. Pure (platform + an executable
 * test are injected) so the PATH-walk is unit-testable off-Windows.
 */
export function findNodeBinaryOnPath(
  pathVar: string,
  platform: NodeJS.Platform,
  isExecutable: (p: string) => boolean,
): string | null {
  if (!pathVar) return null
  // CreateProcess won't launch a `.cmd`, and node.cmd isn't a real interpreter
  // anyway, so only a real node.exe counts on Windows.
  const name = platform === 'win32' ? 'node.exe' : 'node'
  const listSep = platform === 'win32' ? ';' : ':'
  const fileSep = platform === 'win32' ? '\\' : '/'
  for (const dir of pathVar.split(listSep)) {
    if (!dir) continue
    const candidate = dir.endsWith(fileSep) ? dir + name : dir + fileSep + name
    if (isExecutable(candidate)) return candidate
  }
  return null
}

// pi's node binary + matching env, resolved once. `electronAsNode` keeps nodeBin
// and baseEnv in agreement: ELECTRON_RUN_AS_NODE must be set iff we run Electron.
let nodeChoice: { bin: string; electronAsNode: boolean } | null = null

function resolveNodeForPi(): { bin: string; electronAsNode: boolean } {
  if (nodeChoice) return nodeChoice
  // Only Windows needs the real-node preference (the ICU failure is Windows-only);
  // elsewhere Electron-as-node is reliable and version-independent.
  if (process.platform === 'win32') {
    const env = getShellEnv()
    const pathVar = env.Path || env.PATH || process.env.Path || process.env.PATH || ''
    const sysNode = findNodeBinaryOnPath(pathVar, 'win32', (p) => {
      try { accessSync(p, constants.X_OK); return true } catch { return false }
    })
    if (sysNode) {
      log.info('[localAgentHost] running pi with system node: %s', sysNode)
      nodeChoice = { bin: sysNode, electronAsNode: false }
      return nodeChoice
    }
    log.warn('[localAgentHost] no system node.exe on PATH; falling back to Electron-as-node (ELECTRON_RUN_AS_NODE may fail in packaged Windows builds)')
  }
  nodeChoice = { bin: process.execPath, electronAsNode: true }
  return nodeChoice
}

function devPiCli(): string {
  return path.join(app.getAppPath(), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js')
}

function extractedPiCli(): string {
  return path.join(app.getPath('userData'), 'pi', PI_VERSION, 'dist', 'cli.js')
}

function localPiCli(): string {
  const dev = devPiCli()
  return existsSync(dev) ? dev : extractedPiCli()
}

let inflight: Promise<void> | null = null

async function ensureLocalPi(): Promise<void> {
  if (existsSync(localPiCli())) return
  if (inflight) return inflight
  inflight = (async () => {
    const dir = path.join(app.getPath('userData'), 'pi', PI_VERSION)
    const tar = await ensureLocalPiTarball(app.getVersion(), PI_VERSION)
    await mkdir(dir, { recursive: true })
    await execFileP('tar', ['-xzf', tar, '-C', dir])
    if (!existsSync(extractedPiCli())) throw new Error(`pi extract did not produce ${extractedPiCli()}`)
  })().finally(() => { inflight = null })
  return inflight
}

export const localAgentHost: AgentHost = createAgentCapability({
  ensurePi: ensureLocalPi,
  piCliPath: localPiCli,
  // Prefer a real system node (Windows ICU fix); fall back to Electron-as-node.
  nodeBin: () => resolveNodeForPi().bin,
  baseEnv: () => {
    const env = Object.fromEntries(
      Object.entries(getShellEnv()).filter(([, v]) => v !== undefined),
    ) as Record<string, string>
    // ELECTRON_RUN_AS_NODE only when we actually launch Electron as node — set on
    // a real node it would be a harmless no-op, but keep it precise.
    if (resolveNodeForPi().electronAsNode) env.ELECTRON_RUN_AS_NODE = '1'
    return env
  },
})
