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
// Skip-if-exists: never overwrite a user's modified copy.
// =============================================================================

import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { app } from 'electron'
import log from '../../main/logger'
import { agentDirFor } from './agentDir'

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

async function copyIfMissing(src: string, dest: string): Promise<void> {
  try {
    await fsp.access(dest)
    return // already present
  } catch { /* fall through */ }
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  await fsp.copyFile(src, dest)
  log.info('[installPlanMode] installed %s', dest)
}

const installed = new Set<string>()

/** Idempotent — safe to call from AgentManager.create() on every session. */
export async function installPlanModeExtension(cwd: string): Promise<void> {
  const home = agentDirFor(cwd)
  if (installed.has(home)) return
  installed.add(home)
  try {
    const src = sourceDir()
    if (!src) {
      log.warn('[installPlanMode] source dir not found — plan mode extension not installed')
      return
    }
    const destDir = path.join(home, 'extensions', 'cate-plan-mode')
    await copyIfMissing(path.join(src, 'index.ts'), path.join(destDir, 'index.ts'))
    await copyIfMissing(path.join(src, 'package.json'), path.join(destDir, 'package.json'))
  } catch (err) {
    log.warn('[installPlanMode] install failed: %O', err)
  }
}
