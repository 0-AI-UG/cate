// =============================================================================
// localAgentHost — the local machine's AgentHost. Runs pi the same way the
// daemon does (the shared agent capability), but resolves pi locally and runs
// it with Electron-as-node:
//   - dev: pi is in the app's node_modules (unpruned) — use it directly.
//   - packaged: pi is NOT bundled; extract the on-demand cate-pi tarball into
//     userData/pi/<ver> (downloaded from the release / dev dist-companion).
// pi runs under Electron with ELECTRON_RUN_AS_NODE=1 (no system node needed).
// =============================================================================

import { app } from 'electron'
import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import { getShellEnv } from '../shellEnv'
import { createAgentCapability } from '../../companion/capabilities/agent'
import { PI_VERSION } from '../../companion/piVersion'
import { ensureLocalPiTarball } from './companionArtifacts'
import type { AgentHost } from './types'

const execFileP = promisify(execFile)

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
  // Run pi under Electron acting as Node (built-in, asar-aware) so no system
  // node is required.
  nodeBin: () => process.execPath,
  baseEnv: () => ({
    ...(Object.fromEntries(
      Object.entries(getShellEnv()).filter(([, v]) => v !== undefined),
    ) as Record<string, string>),
    ELECTRON_RUN_AS_NODE: '1',
  }),
})
