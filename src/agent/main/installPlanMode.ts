// =============================================================================
// installPlanMode — copy the bundled cate-plan-mode extension into a
// workspace's pi-agent extensions dir on first use, where pi auto-discovers it.
//
// Source lives in our own tree at src/agent/extensions/cate-plan-mode/. Pi
// loads .ts directly via jiti, so we just ship the raw .ts and .json files.
//
// Dev:  src/ is on disk under app.getAppPath().
// Prod: src/agent/extensions/cate-plan-mode/ is copied into resources via
//       electron-builder.yml `extraResources`, so we resolve from
//       process.resourcesPath there.
//
// The SOURCE bundle is always read locally with node fs (it ships inside the
// app). Each DESTINATION is written THROUGH the companion (local fs for the
// local companion, the daemon for a remote one), so remote workspaces are
// seeded too. Skip-if-exists: never overwrite a user's modified copy on the
// host.
// =============================================================================

import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { app } from 'electron'
import log from '../../main/logger'
import { hostAgentDir, hostJoin } from './agentDir'
import type { Companion } from '../../main/companion/types'

/** Source dir of the bundled extension. Tries dev path first (src/ on disk),
 *  then production extraResources copy. */
function sourceDir(): string | null {
  const candidates = [
    path.join(app.getAppPath(), 'src', 'agent', 'extensions', 'cate-plan-mode'),
    path.join(process.resourcesPath ?? '', 'cate-extensions', 'cate-plan-mode'),
  ]
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c
  }
  return null
}

/** True when the host already has a file/dir at `hostPath`. */
async function hostExists(companion: Companion, hostPath: string): Promise<boolean> {
  try {
    await companion.file.stat(hostPath)
    return true
  } catch {
    return false
  }
}

/** Copy a single source file (read locally) to a host destination, skipping
 *  when the host already has it so a user's modified copy is never overwritten. */
async function copyIfMissing(
  companion: Companion,
  src: string,
  destDir: string,
  destName: string,
): Promise<void> {
  const dest = hostJoin(companion.id, destDir, destName)
  if (await hostExists(companion, dest)) return // already present
  let contents: string
  try { contents = await fsp.readFile(src, 'utf-8') }
  catch { return } // source missing — nothing to copy
  await companion.file.mkdir(destDir)
  await companion.file.writeFile(dest, contents)
  log.info('[installPlanMode] installed %s', dest)
}

// Keyed on companionId + host path so the same host path on different companions
// doesn't collide.
const installed = new Set<string>()

/** Idempotent — safe to call from AgentManager.create() on every session.
 *  `cwd` is the HOST path on whichever machine pi runs (local fs path for the
 *  local companion, POSIX path on a remote host). */
export async function installPlanModeExtension(companion: Companion, cwd: string): Promise<void> {
  const home = hostAgentDir(companion.id, cwd)
  const key = companion.id + '\0' + home
  if (installed.has(key)) return
  installed.add(key)
  try {
    const src = sourceDir()
    if (!src) {
      log.warn('[installPlanMode] source dir not found — plan mode extension not installed')
      return
    }
    const destDir = hostJoin(companion.id, home, 'extensions', 'cate-plan-mode')
    await copyIfMissing(companion, path.join(src, 'index.ts'), destDir, 'index.ts')
    await copyIfMissing(companion, path.join(src, 'package.json'), destDir, 'package.json')
  } catch (err) {
    log.warn('[installPlanMode] install failed: %O', err)
  }
}
